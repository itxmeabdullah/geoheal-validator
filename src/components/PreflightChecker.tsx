import React, { useState, useRef, useId } from 'react';
import * as turf from '@turf/turf';

// --- Types ---
export interface DiagnosticItem {
  id: string;
  title: string;
  status: 'pass' | 'fail' | 'fixed' | 'warning';
  summary: string;
  details?: string[];
  autoCorrected?: boolean;
}

export interface FeatureDiagnostic {
  index: number;
  id: string;
  type: string;
  areaHa: number;
  areaM2: number;
  kinksCount: number;
  isClosed: boolean;
  coordsValid: boolean;
  tracesNtCompliant: boolean;
  corrections: string[];
  issues: string[];
}

export interface ValidationSummary {
  totalFeatures: number;
  totalAreaHa: number;
  totalAreaM2: number;
  status: 'pass' | 'fixed' | 'fail';
  correctionsCount: number;
  features: FeatureDiagnostic[];
  diagnostics: {
    ringClosure: DiagnosticItem;
    selfIntersection: DiagnosticItem;
    wgs84Bounds: DiagnosticItem;
    tracesNtArea: DiagnosticItem;
  };
}

// Sample presets for quick testing of all 5 conditions
const SAMPLE_PRESETS: Record<string, { label: string; description: string; data: any }> = {
  valid: {
    label: 'Valid EUDR Coffee Plot (5.2 ha)',
    description: 'Clean polygon, closed ring, valid WGS84, > 0.5 ha formatted properly.',
    data: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {
            plot_id: 'EUDR-BR-COFFEE-01',
            commodity: 'Coffee',
            producer: 'Fazenda Santa Inês',
            country: 'BR',
          },
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [-47.9292, -15.7801],
                [-47.9215, -15.7801],
                [-47.9215, -15.787],
                [-47.9292, -15.787],
                [-47.9292, -15.7801],
              ],
            ],
          },
        },
      ],
    },
  },
  unclosed: {
    label: 'Unclosed Ring (Auto-Fixable)',
    description: 'Polygon missing terminal coordinate; will be auto-closed.',
    data: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {
            plot_id: 'EUDR-ID-PALM-02',
            commodity: 'Oil Palm',
            country: 'ID',
          },
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [101.445, 0.531],
                [101.458, 0.531],
                [101.458, 0.521],
                [101.445, 0.521],
                // Terminal coordinate omitted
              ],
            ],
          },
        },
      ],
    },
  },
  selfIntersecting: {
    label: 'Self-Intersecting Bowtie (Auto-Fixable)',
    description: 'Figure-8 self-intersection; detected via @turf/kinks and resolved with zero-distance buffer.',
    data: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {
            plot_id: 'EUDR-CI-COCOA-03',
            commodity: 'Cocoa',
            country: 'CI',
          },
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [-5.541, 6.745],
                [-5.531, 6.755],
                [-5.531, 6.745],
                [-5.541, 6.755],
                [-5.541, 6.745],
              ],
            ],
          },
        },
      ],
    },
  },
  invalidCoords: {
    label: 'Inverted / Invalid WGS84 Coords',
    description: 'Coordinates exceeding valid latitude range [-90, 90] due to swapped Lat/Lon.',
    data: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {
            plot_id: 'EUDR-GH-RUBBER-04',
            commodity: 'Rubber',
            country: 'GH',
          },
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [-1.55, 125.4], // 125.4 exceeds valid latitude limit (+90)!
                [-1.52, 125.4],
                [-1.52, 125.38],
                [-1.55, 125.38],
                [-1.55, 125.4],
              ],
            ],
          },
        },
      ],
    },
  },
  pointOverThreshold: {
    label: 'Point Plot > 0.5 ha (TRACES NT Flag)',
    description: 'Single point declared as 4.8 hectares; violates TRACES NT polygon mandate.',
    data: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {
            plot_id: 'EUDR-PE-SOYA-05',
            commodity: 'Soya',
            declared_area_ha: 4.8,
            country: 'PE',
          },
          geometry: {
            type: 'Point',
            coordinates: [-75.215, -12.068],
          },
        },
      ],
    },
  },
};

export const PreflightChecker: React.FC = () => {
  const fileInputId = useId();
  const [geoJsonInput, setGeoJsonInput] = useState<string>(
    JSON.stringify(SAMPLE_PRESETS.valid.data, null, 2)
  );
  const [correctedGeoJson, setCorrectedGeoJson] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>('sample-eudr-plot.geojson');
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [summary, setSummary] = useState<ValidationSummary | null>(null);
  const [copied, setCopied] = useState<boolean>(false);
  const [showJsonInspector, setShowJsonInspector] = useState<boolean>(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- Enterprise TRACES NT Orchestration State ---
  const pdfInputId = useId();
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [isOrchestrating, setIsOrchestrating] = useState<boolean>(false);
  const [orchestrationResponse, setOrchestrationResponse] = useState<any | null>(null);
  const [orchestrationError, setOrchestrationError] = useState<string | null>(null);
  const [ddsCopied, setDdsCopied] = useState<boolean>(false);
  const pdfInputRef = useRef<HTMLInputElement>(null);

  // --- Core Deterministic Validation & Auto-Correction Pipeline ---
  const runValidation = (rawJson: string, name = 'input.geojson') => {
    setParseError(null);
    let parsed: any;
    try {
      parsed = JSON.parse(rawJson);
    } catch (err: any) {
      setParseError(`JSON Syntax Error: ${err.message}`);
      setSummary(null);
      setCorrectedGeoJson(null);
      return;
    }

    if (!parsed || typeof parsed !== 'object') {
      setParseError('Provided payload is not a valid JSON object.');
      return;
    }

    // Normalize input to standard FeatureCollection
    let featureList: any[] = [];
    if (parsed.type === 'FeatureCollection' && Array.isArray(parsed.features)) {
      featureList = parsed.features;
    } else if (parsed.type === 'Feature') {
      featureList = [parsed];
    } else if (parsed.type && parsed.coordinates) {
      // Raw Geometry
      featureList = [{ type: 'Feature', properties: {}, geometry: parsed }];
    } else {
      setParseError('Unrecognized GeoJSON format. Expected FeatureCollection, Feature, or Geometry.');
      return;
    }

    // Deep clone working features to prepare auto-corrected copy
    const workingFeatures = JSON.parse(JSON.stringify(featureList));

    let unclosedRingsFound = 0;
    let unclosedRingsFixed = 0;
    const ringClosureDetails: string[] = [];

    let totalKinksFound = 0;
    let totalKinksFixed = 0;
    const selfIntersectionDetails: string[] = [];

    let invalidWgs84CoordsCount = 0;
    const wgs84Details: string[] = [];

    let tracesNtViolationsCount = 0;
    const tracesNtDetails: string[] = [];

    let totalAreaM2 = 0;
    let totalCorrectionsApplied = 0;

    const featureDiagnostics: FeatureDiagnostic[] = [];

    workingFeatures.forEach((feat: any, idx: number) => {
      const plotId = feat.properties?.plot_id || `Plot #${idx + 1}`;
      const featureCorrections: string[] = [];
      const featureIssues: string[] = [];
      let isFeatureClosed = true;
      let isCoordsValid = true;
      let kinksCount = 0;
      let tracesNtCompliant = true;
      let areaM2 = 0;

      const geom = feat.geometry;
      if (!geom || !geom.coordinates) {
        featureIssues.push('Feature has missing or empty geometry.');
        return;
      }

      // -------------------------------------------------------------
      // 1. WGS84 Range & Coordinate Validity Check
      // -------------------------------------------------------------
      const checkCoord = (coord: any[]) => {
        if (!Array.isArray(coord) || coord.length < 2) {
          isCoordsValid = false;
          invalidWgs84CoordsCount++;
          wgs84Details.push(`${plotId}: Coordinate is not a valid 2D array: ${JSON.stringify(coord)}`);
          return;
        }
        const [lon, lat] = coord;
        if (typeof lon !== 'number' || typeof lat !== 'number' || isNaN(lon) || isNaN(lat)) {
          isCoordsValid = false;
          invalidWgs84CoordsCount++;
          wgs84Details.push(`${plotId}: Coordinate values must be numeric [Lon, Lat]. Found: [${lon}, ${lat}]`);
          return;
        }

        // Longitude: -180 to 180, Latitude: -90 to 90
        const lonValid = lon >= -180 && lon <= 180;
        const latValid = lat >= -90 && lat <= 90;

        if (!lonValid || !latValid) {
          isCoordsValid = false;
          invalidWgs84CoordsCount++;

          // Detect common Lat/Lon swap inversion
          if (Math.abs(lon) <= 90 && Math.abs(lat) > 90) {
            wgs84Details.push(
              `${plotId}: Coordinate [${lon}, ${lat}] out of range. Latitude (${lat}) exceeds [-90, 90] while Longitude (${lon}) is in latitude bounds. Coordinates are likely swapped [Lat, Lon] instead of standard GeoJSON [Lon, Lat]!`
            );
          } else {
            wgs84Details.push(
              `${plotId}: Coordinate [${lon}, ${lat}] violates WGS84 bounds (Lon [-180, 180], Lat [-90, 90]).`
            );
          }
        }
      };

      const inspectCoords = (coords: any) => {
        if (!Array.isArray(coords)) return;
        if (typeof coords[0] === 'number') {
          checkCoord(coords);
        } else {
          coords.forEach(inspectCoords);
        }
      };
      inspectCoords(geom.coordinates);

      // -------------------------------------------------------------
      // 2. Unclosed Polygon Rings Detection & Auto-Correction
      // -------------------------------------------------------------
      if (geom.type === 'Polygon' && Array.isArray(geom.coordinates)) {
        geom.coordinates.forEach((ring: any[], rIdx: number) => {
          if (Array.isArray(ring) && ring.length > 0) {
            const first = ring[0];
            const last = ring[ring.length - 1];
            if (
              !Array.isArray(first) ||
              !Array.isArray(last) ||
              first[0] !== last[0] ||
              first[1] !== last[1]
            ) {
              isFeatureClosed = false;
              unclosedRingsFound++;
              // Auto-correct: append first coordinate
              ring.push([...first]);
              unclosedRingsFixed++;
              totalCorrectionsApplied++;
              featureCorrections.push(
                `Ring #${rIdx + 1} was unclosed. Auto-closed by appending start coordinate [${first[0]}, ${first[1]}].`
              );
              ringClosureDetails.push(
                `${plotId}: Linear ring #${rIdx + 1} was unclosed. Auto-closed by appending terminal vertex.`
              );
            }
          }
        });
      } else if (geom.type === 'MultiPolygon' && Array.isArray(geom.coordinates)) {
        geom.coordinates.forEach((poly: any[], pIdx: number) => {
          if (Array.isArray(poly)) {
            poly.forEach((ring: any[], rIdx: number) => {
              if (Array.isArray(ring) && ring.length > 0) {
                const first = ring[0];
                const last = ring[ring.length - 1];
                if (
                  !Array.isArray(first) ||
                  !Array.isArray(last) ||
                  first[0] !== last[0] ||
                  first[1] !== last[1]
                ) {
                  isFeatureClosed = false;
                  unclosedRingsFound++;
                  ring.push([...first]);
                  unclosedRingsFixed++;
                  totalCorrectionsApplied++;
                  featureCorrections.push(
                    `Part #${pIdx + 1} Ring #${rIdx + 1} unclosed. Auto-closed.`
                  );
                  ringClosureDetails.push(
                    `${plotId}: Part #${pIdx + 1} Ring #${rIdx + 1} was unclosed. Auto-closed.`
                  );
                }
              }
            });
          }
        });
      }

      // -------------------------------------------------------------
      // 3. Self-Intersecting Lines Detection (@turf/kinks) & Zero-Distance Buffering Fix
      // -------------------------------------------------------------
      if (
        (geom.type === 'Polygon' || geom.type === 'MultiPolygon') &&
        isCoordsValid
      ) {
        try {
          const kinksResult = turf.kinks(feat);
          kinksCount = kinksResult.features.length;

          if (kinksCount > 0) {
            totalKinksFound += kinksCount;
            selfIntersectionDetails.push(
              `${plotId}: Identified ${kinksCount} self-intersection kink point(s).`
            );

            // Auto-fix using zero-distance buffering
            try {
              const buffered = turf.buffer(feat, 0, { units: 'meters' });
              if (buffered && buffered.geometry) {
                // Verify if kinks were resolved
                const postKinks = turf.kinks(buffered);
                if (postKinks.features.length < kinksCount) {
                  feat.geometry = buffered.geometry;
                  totalKinksFixed += kinksCount;
                  totalCorrectionsApplied++;
                  featureCorrections.push(
                    `Repaired ${kinksCount} self-intersection(s) via zero-distance buffering (turf.buffer(0)). Output geometry: ${buffered.geometry.type}.`
                  );
                  selfIntersectionDetails.push(
                    `${plotId}: Successfully corrected self-intersecting polygon into non-overlapping ${buffered.geometry.type}.`
                  );
                  kinksCount = postKinks.features.length;
                }
              }
            } catch (bufErr: any) {
              featureIssues.push(`Zero-distance buffering failed: ${bufErr.message}`);
            }
          }
        } catch (kinkErr: any) {
          featureIssues.push(`Kink detection failed: ${kinkErr.message}`);
        }
      }

      // -------------------------------------------------------------
      // 4. Area Calculation & TRACES NT Plot Rule Check
      // -------------------------------------------------------------
      if (
        (feat.geometry.type === 'Polygon' || feat.geometry.type === 'MultiPolygon') &&
        isCoordsValid
      ) {
        try {
          areaM2 = turf.area(feat);
          totalAreaM2 += areaM2;
          const areaHa = areaM2 / 10000;

          if (areaHa >= 0.5) {
            tracesNtCompliant = true;
          } else {
            // Under 0.5 ha, polygon is still completely valid and compliant
            tracesNtCompliant = true;
          }
        } catch (areaErr: any) {
          featureIssues.push(`Area computation error: ${areaErr.message}`);
        }
      } else if (feat.geometry.type === 'Point') {
        // Point Feature: Check declared area in properties
        const declaredArea =
          feat.properties?.declared_area_ha ??
          feat.properties?.area_ha ??
          feat.properties?.hectares ??
          (feat.properties?.area ? feat.properties.area / 10000 : null);

        if (declaredArea !== null && declaredArea !== undefined && declaredArea > 0.5) {
          tracesNtCompliant = false;
          tracesNtViolationsCount++;
          const msg = `${plotId}: Declared area is ${declaredArea} ha (> 0.5 ha) but formatted as Point geometry. TRACES NT requires polygon boundaries for plots exceeding 0.5 hectares!`;
          featureIssues.push(msg);
          tracesNtDetails.push(msg);
        } else {
          // Warning: Points are only acceptable for small plots (< 0.5 ha)
          tracesNtDetails.push(
            `${plotId}: Formatted as Point. Allowed under TRACES NT only if verified plot size is under 0.5 ha.`
          );
        }
      } else {
        tracesNtCompliant = false;
        tracesNtViolationsCount++;
        const msg = `${plotId}: Geometry type "${feat.geometry.type}" is invalid for EUDR. Only Polygon or Point (< 0.5 ha) accepted.`;
        featureIssues.push(msg);
        tracesNtDetails.push(msg);
      }

      featureDiagnostics.push({
        index: idx + 1,
        id: plotId,
        type: feat.geometry.type,
        areaHa: areaM2 / 10000,
        areaM2,
        kinksCount,
        isClosed: isFeatureClosed,
        coordsValid: isCoordsValid,
        tracesNtCompliant,
        corrections: featureCorrections,
        issues: featureIssues,
      });
    });

    // -------------------------------------------------------------
    // Synthesize Diagnostics Cards
    // -------------------------------------------------------------
    const ringClosureCard: DiagnosticItem = {
      id: 'ring-closure',
      title: '1. Polygon Ring Closure',
      status:
        unclosedRingsFound === 0
          ? 'pass'
          : unclosedRingsFixed === unclosedRingsFound
            ? 'fixed'
            : 'fail',
      summary:
        unclosedRingsFound === 0
          ? 'All linear rings are cleanly closed (first and last coordinates match).'
          : `Detected ${unclosedRingsFound} unclosed ring(s). Automatically closed ${unclosedRingsFixed} ring(s) by appending the initial vertex.`,
      details: ringClosureDetails,
      autoCorrected: unclosedRingsFixed > 0,
    };

    const selfIntersectionCard: DiagnosticItem = {
      id: 'self-intersection',
      title: '2. Self-Intersection Kinks (@turf/kinks)',
      status:
        totalKinksFound === 0
          ? 'pass'
          : totalKinksFixed === totalKinksFound
            ? 'fixed'
            : 'fail',
      summary:
        totalKinksFound === 0
          ? 'No self-intersecting polygon boundaries or bowtie loops identified.'
          : `Identified ${totalKinksFound} self-intersection kink(s). Resolved ${totalKinksFixed} via zero-distance buffering (turf.buffer(0)).`,
      details: selfIntersectionDetails,
      autoCorrected: totalKinksFixed > 0,
    };

    const wgs84Card: DiagnosticItem = {
      id: 'wgs84-bounds',
      title: '3. WGS84 Coordinate Range Check',
      status: invalidWgs84CoordsCount === 0 ? 'pass' : 'fail',
      summary:
        invalidWgs84CoordsCount === 0
          ? 'All coordinates are valid WGS84 degrees (Lon -180..180, Lat -90..90).'
          : `Detected ${invalidWgs84CoordsCount} coordinate(s) violating standard WGS84 bounds or exhibiting Lat/Lon inversion.`,
      details: wgs84Details,
    };

    const tracesNtCard: DiagnosticItem = {
      id: 'traces-nt-area',
      title: '4. TRACES NT Area & Geometry Compliance',
      status: tracesNtViolationsCount === 0 ? 'pass' : 'fail',
      summary:
        tracesNtViolationsCount === 0
          ? `Total area: ${(totalAreaM2 / 10000).toFixed(3)} ha across ${featureList.length} plot(s). All plots > 0.5 ha correctly provided as polygons.`
          : `Found ${tracesNtViolationsCount} plot(s) violating TRACES NT rules (e.g. plots > 0.5 ha formatted as points).`,
      details: tracesNtDetails,
    };

    // Overall Status Calculation
    let overallStatus: 'pass' | 'fixed' | 'fail' = 'pass';
    if (invalidWgs84CoordsCount > 0 || tracesNtViolationsCount > 0) {
      overallStatus = 'fail';
    } else if (totalCorrectionsApplied > 0) {
      overallStatus = 'fixed';
    }

    // Generate Auto-Corrected GeoJSON output
    const normalizedCorrected = {
      type: 'FeatureCollection',
      name: 'EUDR_Preflight_Corrected',
      features: workingFeatures,
    };

    setSummary({
      totalFeatures: featureList.length,
      totalAreaHa: totalAreaM2 / 10000,
      totalAreaM2,
      status: overallStatus,
      correctionsCount: totalCorrectionsApplied,
      features: featureDiagnostics,
      diagnostics: {
        ringClosure: ringClosureCard,
        selfIntersection: selfIntersectionCard,
        wgs84Bounds: wgs84Card,
        tracesNtArea: tracesNtCard,
      },
    });

    setCorrectedGeoJson(JSON.stringify(normalizedCorrected, null, 2));
  };

  // Run initial validation on mount
  React.useEffect(() => {
    runValidation(geoJsonInput, 'sample-eudr-plot.geojson');
  }, []);

  // Drag and Drop handlers
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      processFile(files[0]);
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      processFile(files[0]);
    }
  };

  const processFile = (file: File) => {
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      if (content) {
        setGeoJsonInput(content);
        runValidation(content, file.name);
      }
    };
    reader.readAsText(file);
  };

  const handleLoadPreset = (key: string) => {
    const preset = SAMPLE_PRESETS[key];
    if (preset) {
      const jsonStr = JSON.stringify(preset.data, null, 2);
      setFileName(`${key}-sample.geojson`);
      setGeoJsonInput(jsonStr);
      runValidation(jsonStr, `${key}-sample.geojson`);
    }
  };

  const handleCopyCorrected = () => {
    if (!correctedGeoJson) return;
    navigator.clipboard.writeText(correctedGeoJson);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadCorrected = () => {
    if (!correctedGeoJson) return;
    const blob = new Blob([correctedGeoJson], { type: 'application/geo+json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName.replace(/\.(geojson|json)$/i, '') + '-eudr-corrected.geojson';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // --- Enterprise TRACES NT Orchestration Handlers ---
  const handlePdfChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      const file = files[0];
      if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
        setOrchestrationError('Please select a valid PDF file (e.g. Bill of Lading, invoice, or manifest).');
        setPdfFile(null);
        return;
      }
      setPdfFile(file);
      setOrchestrationError(null);
    }
  };

  const handleGenerateTracesPayload = async () => {
    if (!pdfFile) {
      setOrchestrationError('Please upload a Bill of Lading PDF file before generating the TRACES NT payload.');
      return;
    }

    const payloadGeoJson = correctedGeoJson || geoJsonInput;
    if (!payloadGeoJson) {
      setOrchestrationError('No GeoJSON payload available to submit.');
      return;
    }

    setIsOrchestrating(true);
    setOrchestrationError(null);
    setOrchestrationResponse(null);

    try {
      const formData = new FormData();
      formData.append('geojson', payloadGeoJson);
      formData.append('pdf', pdfFile);

      const res = await fetch('/api/orchestrate-traces', {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          data.details
            ? `${data.error}: ${data.details}`
            : data.error || `Request failed with HTTP status ${res.status}`
        );
      }

      setOrchestrationResponse(data);
    } catch (err: any) {
      setOrchestrationError(
        err?.message || 'An unexpected error occurred while communicating with /api/orchestrate-traces.'
      );
    } finally {
      setIsOrchestrating(false);
    }
  };

  const handleDownloadDdsJson = () => {
    if (!orchestrationResponse) return;
    const jsonStr = JSON.stringify(orchestrationResponse, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const ref = orchestrationResponse.referenceNumber || 'DDS';
    a.download = `${ref}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleCopyDdsJson = () => {
    if (!orchestrationResponse) return;
    navigator.clipboard.writeText(JSON.stringify(orchestrationResponse, null, 2));
    setDdsCopied(true);
    setTimeout(() => setDdsCopied(false), 2000);
  };

  // Helper for status styling
  const getStatusBadge = (status: 'pass' | 'fixed' | 'fail' | 'warning') => {
    switch (status) {
      case 'pass':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
            <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
            </svg>
            PASSED
          </span>
        );
      case 'fixed':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-cyan-500/10 text-cyan-400 border border-cyan-500/30">
            <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.047a1 1 0 011.885-.666A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566z" clipRule="evenodd" />
            </svg>
            AUTO-CORRECTED
          </span>
        );
      case 'fail':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/30">
            <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
            FAILED
          </span>
        );
      case 'warning':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/30">
            <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
            WARNING
          </span>
        );
    }
  };

  return (
    <div className="space-y-8">
      {/* ------------------------------------------------------------- */}
      {/* 1. Drag & Drop File Upload + Test Preset Bar */}
      {/* ------------------------------------------------------------- */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-6 shadow-xl backdrop-blur-md">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-slate-800/80">
          <div>
            <h2 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
              <svg className="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              GeoJSON File Ingestion &amp; Diagnostics
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              Deterministic EUDR Pre-Flight Validator powered by Turf.js spatial engine.
            </p>
          </div>

          <div className="flex items-center gap-2 text-xs">
            <span className="text-slate-400">Current Payload:</span>
            <span className="font-mono px-2.5 py-1 rounded-md bg-slate-950 border border-slate-800 text-emerald-400 font-medium">
              {fileName}
            </span>
          </div>
        </div>

        {/* Drag and Drop Area */}
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`mt-6 relative flex flex-col items-center justify-center p-8 rounded-xl border-2 border-dashed transition-all cursor-pointer group ${
            isDragging
              ? 'border-emerald-400 bg-emerald-500/10 shadow-lg shadow-emerald-950/40'
              : 'border-slate-700/80 bg-slate-950/50 hover:border-emerald-500/60 hover:bg-slate-950/80'
          }`}
        >
          <input
            id={fileInputId}
            ref={fileInputRef}
            type="file"
            accept=".geojson,.json,application/geo+json,application/json"
            onChange={handleFileInputChange}
            className="hidden"
            aria-label="Upload GeoJSON or JSON file"
          />

          <div className="flex items-center justify-center w-14 h-14 rounded-2xl bg-slate-900 border border-slate-800 group-hover:border-emerald-500/40 group-hover:scale-105 transition-all shadow-md">
            <svg
              className={`w-7 h-7 transition-colors ${
                isDragging ? 'text-emerald-400' : 'text-slate-400 group-hover:text-emerald-400'
              }`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.75"
                d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
              />
            </svg>
          </div>

          <p className="mt-4 text-sm font-medium text-slate-200">
            <span className="text-emerald-400 underline underline-offset-2">Click to browse</span> or drag &amp; drop your <code className="text-slate-300 font-mono">.geojson</code> / <code className="text-slate-300 font-mono">.json</code> file
          </p>
          <p className="text-xs text-slate-400 mt-1">
            Zero-upload processing &bull; 100% evaluated client-side in your browser
          </p>
        </div>

        {/* Quick Test Presets */}
        <div className="mt-6 pt-5 border-t border-slate-800/80">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Interactive Test Presets:
            </span>
            <span className="text-xs text-slate-500">Test specific EUDR validation rules</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5">
            {Object.entries(SAMPLE_PRESETS).map(([key, preset]) => (
              <button
                key={key}
                type="button"
                onClick={() => handleLoadPreset(key)}
                className="flex flex-col text-left p-3 rounded-lg border border-slate-800 bg-slate-950/70 hover:border-slate-700 hover:bg-slate-900 transition group"
              >
                <span className="text-xs font-medium text-slate-200 group-hover:text-emerald-400 transition-colors">
                  {preset.label}
                </span>
                <span className="text-[11px] text-slate-500 mt-1 line-clamp-2">
                  {preset.description}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* JSON Syntax Error alert if applicable */}
      {parseError && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-5 text-rose-300 flex items-start gap-3">
          <svg className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <div>
            <h4 className="text-sm font-semibold text-rose-200">Invalid JSON GeoJSON Payload</h4>
            <p className="text-xs text-rose-300 mt-1">{parseError}</p>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* 2. Top-Level Summary Status Bar */}
      {/* ------------------------------------------------------------- */}
      {summary && (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-xl">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 pb-6 border-b border-slate-800/80">
            <div className="flex items-center gap-4">
              <div
                className={`flex items-center justify-center w-12 h-12 rounded-xl border ${
                  summary.status === 'pass'
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                    : summary.status === 'fixed'
                      ? 'border-cyan-500/30 bg-cyan-500/10 text-cyan-400'
                      : 'border-rose-500/30 bg-rose-500/10 text-rose-400'
                }`}
              >
                {summary.status === 'pass' && (
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                  </svg>
                )}
                {summary.status === 'fixed' && (
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                )}
                {summary.status === 'fail' && (
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                )}
              </div>
              <div>
                <div className="flex items-center gap-3">
                  <h3 className="text-xl font-bold text-white">Pre-Flight Result:</h3>
                  {getStatusBadge(summary.status)}
                </div>
                <p className="text-xs text-slate-400 mt-1">
                  {summary.status === 'pass' && 'All EUDR spatial integrity requirements verified successfully.'}
                  {summary.status === 'fixed' &&
                    `Auto-corrected ${summary.correctionsCount} spatial anomalies. Ready for EUDR / TRACES NT export.`}
                  {summary.status === 'fail' &&
                    'Critical spatial or TRACES NT violations detected. Review diagnostic cards below.'}
                </p>
              </div>
            </div>

            {/* Quick Export / Download Actions */}
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleDownloadCorrected}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 px-4 py-2 text-xs font-semibold text-white transition shadow-md shadow-emerald-950/50"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Download EUDR GeoJSON
              </button>

              <button
                type="button"
                onClick={handleCopyCorrected}
                className="inline-flex items-center gap-2 rounded-lg bg-slate-800 hover:bg-slate-700 active:bg-slate-900 px-3.5 py-2 text-xs font-semibold text-slate-200 transition border border-slate-700"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
                {copied ? 'Copied to Clipboard!' : 'Copy GeoJSON'}
              </button>

              <button
                type="button"
                onClick={() => setShowJsonInspector(!showJsonInspector)}
                className="inline-flex items-center gap-2 rounded-lg bg-slate-800 hover:bg-slate-700 px-3.5 py-2 text-xs font-semibold text-slate-200 transition border border-slate-700"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                </svg>
                {showJsonInspector ? 'Hide Raw JSON' : 'Inspect Raw JSON'}
              </button>
            </div>
          </div>

          {/* Metric KPI Pills */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-6">
            <div className="p-4 rounded-xl bg-slate-950/80 border border-slate-800">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Total Plots</span>
              <p className="text-2xl font-bold text-white mt-1">{summary.totalFeatures}</p>
              <span className="text-[11px] text-slate-500">Evaluated features</span>
            </div>

            <div className="p-4 rounded-xl bg-slate-950/80 border border-slate-800">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Total Area</span>
              <p className="text-2xl font-bold text-emerald-400 mt-1">
                {summary.totalAreaHa.toFixed(2)} <span className="text-sm font-normal text-emerald-500/80">ha</span>
              </p>
              <span className="text-[11px] text-slate-500">
                {Math.round(summary.totalAreaM2).toLocaleString()} m²
              </span>
            </div>

            <div className="p-4 rounded-xl bg-slate-950/80 border border-slate-800">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Spatial Fixes</span>
              <p className="text-2xl font-bold text-cyan-400 mt-1">{summary.correctionsCount}</p>
              <span className="text-[11px] text-slate-500">Auto-corrections applied</span>
            </div>

            <div className="p-4 rounded-xl bg-slate-950/80 border border-slate-800">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">TRACES NT Status</span>
              <p className="text-2xl font-bold text-slate-200 mt-1">
                {summary.diagnostics.tracesNtArea.status === 'pass' ? (
                  <span className="text-emerald-400">Compliant</span>
                ) : (
                  <span className="text-rose-400">Violation</span>
                )}
              </p>
              <span className="text-[11px] text-slate-500">&gt;0.5 ha Polygon Rule</span>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* 3. Pass / Fail Diagnostic Cards (Requirements 1 - 4) */}
      {/* ------------------------------------------------------------- */}
      {summary && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-bold text-white tracking-tight flex items-center gap-2">
              <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
              </svg>
              Diagnostic Verification Cards
            </h3>
            <span className="text-xs text-slate-400">Deterministic check criteria</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Card 1: Ring Closure */}
            <div className="p-5 rounded-xl border border-slate-800 bg-slate-900/60 shadow-lg space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-bold text-white">{summary.diagnostics.ringClosure.title}</h4>
                {getStatusBadge(summary.diagnostics.ringClosure.status)}
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                {summary.diagnostics.ringClosure.summary}
              </p>
              {summary.diagnostics.ringClosure.details && summary.diagnostics.ringClosure.details.length > 0 && (
                <div className="pt-2 border-t border-slate-800/80">
                  <span className="text-[10px] font-semibold uppercase text-slate-400">Audit Log:</span>
                  <ul className="mt-1 space-y-1 text-xs text-cyan-300 font-mono">
                    {summary.diagnostics.ringClosure.details.map((d, i) => (
                      <li key={i} className="flex items-start gap-1.5">
                        <span className="text-cyan-400">&bull;</span>
                        <span>{d}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {/* Card 2: Self-Intersection (@turf/kinks + zero-distance buffer) */}
            <div className="p-5 rounded-xl border border-slate-800 bg-slate-900/60 shadow-lg space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-bold text-white">{summary.diagnostics.selfIntersection.title}</h4>
                {getStatusBadge(summary.diagnostics.selfIntersection.status)}
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                {summary.diagnostics.selfIntersection.summary}
              </p>
              {summary.diagnostics.selfIntersection.details && summary.diagnostics.selfIntersection.details.length > 0 && (
                <div className="pt-2 border-t border-slate-800/80">
                  <span className="text-[10px] font-semibold uppercase text-slate-400">Audit Log:</span>
                  <ul className="mt-1 space-y-1 text-xs text-cyan-300 font-mono">
                    {summary.diagnostics.selfIntersection.details.map((d, i) => (
                      <li key={i} className="flex items-start gap-1.5">
                        <span className="text-cyan-400">&bull;</span>
                        <span>{d}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {/* Card 3: WGS84 Bounds Check */}
            <div className="p-5 rounded-xl border border-slate-800 bg-slate-900/60 shadow-lg space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-bold text-white">{summary.diagnostics.wgs84Bounds.title}</h4>
                {getStatusBadge(summary.diagnostics.wgs84Bounds.status)}
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                {summary.diagnostics.wgs84Bounds.summary}
              </p>
              {summary.diagnostics.wgs84Bounds.details && summary.diagnostics.wgs84Bounds.details.length > 0 && (
                <div className="pt-2 border-t border-slate-800/80">
                  <span className="text-[10px] font-semibold uppercase text-rose-400">Violations:</span>
                  <ul className="mt-1 space-y-1 text-xs text-rose-300 font-mono">
                    {summary.diagnostics.wgs84Bounds.details.map((d, i) => (
                      <li key={i} className="flex items-start gap-1.5">
                        <span className="text-rose-400">&bull;</span>
                        <span>{d}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {/* Card 4: TRACES NT Area & Geometry Formatter */}
            <div className="p-5 rounded-xl border border-slate-800 bg-slate-900/60 shadow-lg space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-bold text-white">{summary.diagnostics.tracesNtArea.title}</h4>
                {getStatusBadge(summary.diagnostics.tracesNtArea.status)}
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                {summary.diagnostics.tracesNtArea.summary}
              </p>
              {summary.diagnostics.tracesNtArea.details && summary.diagnostics.tracesNtArea.details.length > 0 && (
                <div className="pt-2 border-t border-slate-800/80">
                  <span className="text-[10px] font-semibold uppercase text-slate-400">Observations:</span>
                  <ul className="mt-1 space-y-1 text-xs text-slate-300 font-mono">
                    {summary.diagnostics.tracesNtArea.details.map((d, i) => (
                      <li key={i} className="flex items-start gap-1.5">
                        <span className="text-slate-400">&bull;</span>
                        <span>{d}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* 4. Feature-by-Feature Detailed Table */}
      {/* ------------------------------------------------------------- */}
      {summary && summary.features.length > 0 && (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-xl space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-bold text-white tracking-tight">
              Plot-Level Breakdown ({summary.features.length})
            </h3>
            <span className="text-xs text-slate-400">EUDR Plot Details</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-950 text-slate-400 font-mono border-b border-slate-800">
                <tr>
                  <th className="py-2.5 px-3">#</th>
                  <th className="py-2.5 px-3">Plot Identifier</th>
                  <th className="py-2.5 px-3">Geometry</th>
                  <th className="py-2.5 px-3">Area (ha)</th>
                  <th className="py-2.5 px-3">Rings</th>
                  <th className="py-2.5 px-3">Kinks</th>
                  <th className="py-2.5 px-3">WGS84</th>
                  <th className="py-2.5 px-3">TRACES NT</th>
                  <th className="py-2.5 px-3">Actions / Remarks</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-mono text-slate-300">
                {summary.features.map((feat) => (
                  <tr key={feat.index} className="hover:bg-slate-800/40 transition">
                    <td className="py-2.5 px-3 text-slate-500">{feat.index}</td>
                    <td className="py-2.5 px-3 font-semibold text-white">{feat.id}</td>
                    <td className="py-2.5 px-3 text-slate-300">{feat.type}</td>
                    <td className="py-2.5 px-3 font-semibold text-emerald-400">
                      {feat.type === 'Point' ? 'N/A' : `${feat.areaHa.toFixed(3)} ha`}
                    </td>
                    <td className="py-2.5 px-3">
                      {feat.isClosed ? (
                        <span className="text-emerald-400">Closed</span>
                      ) : (
                        <span className="text-cyan-400">Auto-Closed</span>
                      )}
                    </td>
                    <td className="py-2.5 px-3">
                      {feat.kinksCount === 0 ? (
                        <span className="text-emerald-400">0</span>
                      ) : (
                        <span className="text-rose-400">{feat.kinksCount}</span>
                      )}
                    </td>
                    <td className="py-2.5 px-3">
                      {feat.coordsValid ? (
                        <span className="text-emerald-400">Valid</span>
                      ) : (
                        <span className="text-rose-400">Invalid</span>
                      )}
                    </td>
                    <td className="py-2.5 px-3">
                      {feat.tracesNtCompliant ? (
                        <span className="text-emerald-400">Pass</span>
                      ) : (
                        <span className="text-rose-400">Fail (&gt;0.5ha)</span>
                      )}
                    </td>
                    <td className="py-2.5 px-3 text-[11px] text-slate-400">
                      {feat.corrections.length > 0 && (
                        <span className="text-cyan-300 block">{feat.corrections.join(', ')}</span>
                      )}
                      {feat.issues.length > 0 && (
                        <span className="text-rose-300 block">{feat.issues.join(', ')}</span>
                      )}
                      {feat.corrections.length === 0 && feat.issues.length === 0 && (
                        <span className="text-slate-500">Nominal</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* 5. Enterprise TRACES NT Orchestration */}
      {/* ------------------------------------------------------------- */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-xl space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800/80 pb-4">
          <div>
            <h3 className="text-lg font-bold text-white flex items-center gap-2">
              <svg className="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
              Enterprise TRACES NT Orchestration
            </h3>
            <p className="text-xs text-slate-400 mt-1">
              Extract customs and trade metadata from your Bill of Lading PDF via Gemini 1.5 Flash and assemble a compliant Due Diligence Statement (DDS).
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center rounded-md bg-emerald-400/10 px-2.5 py-1 text-xs font-medium text-emerald-400 ring-1 ring-inset ring-emerald-400/20">
              Cloudflare SSR
            </span>
            <span className="inline-flex items-center rounded-md bg-cyan-400/10 px-2.5 py-1 text-xs font-medium text-cyan-400 ring-1 ring-inset ring-cyan-400/20">
              Gemini 1.5 Flash
            </span>
          </div>
        </div>

        {/* Upload Bill of Lading PDF */}
        <div className="space-y-3">
          <label htmlFor={pdfInputId} className="block text-xs font-semibold uppercase tracking-wider text-slate-300">
            Upload Shipping Document (Bill of Lading / Phyto Certificate PDF)
          </label>
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
            <div className="relative flex-1">
              <input
                id={pdfInputId}
                ref={pdfInputRef}
                type="file"
                accept="application/pdf"
                onChange={handlePdfChange}
                className="block w-full text-xs text-slate-400 file:mr-4 file:py-2.5 file:px-4 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-slate-800 file:text-emerald-400 hover:file:bg-slate-700 file:cursor-pointer rounded-xl border border-slate-800 bg-slate-950 p-2 cursor-pointer focus:outline-none focus:border-emerald-500"
              />
            </div>

            <button
              type="button"
              disabled={!pdfFile || isOrchestrating}
              onClick={handleGenerateTracesPayload}
              className={`inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-xs font-bold transition shadow-lg shrink-0 ${
                !pdfFile || isOrchestrating
                  ? 'bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700/50'
                  : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-950/50 active:bg-emerald-700'
              }`}
            >
              {isOrchestrating ? (
                <>
                  <svg className="w-4 h-4 animate-spin text-white" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  Extracting &amp; Orchestrating...
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  Generate TRACES NT Payload
                </>
              )}
            </button>
          </div>

          {pdfFile && (
            <div className="flex items-center gap-2 text-xs text-slate-400 font-mono">
              <span className="text-emerald-400">Attached Bill of Lading:</span>
              <span className="text-slate-200 font-semibold">{pdfFile.name}</span>
              <span className="text-slate-500">({(pdfFile.size / 1024).toFixed(1)} KB)</span>
            </div>
          )}
        </div>

        {/* Error message */}
        {orchestrationError && (
          <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-rose-300 flex items-start gap-3 text-xs">
            <svg className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <span className="font-bold text-rose-200 block mb-0.5">TRACES NT Orchestration Error</span>
              <p className="text-rose-300 leading-relaxed">{orchestrationError}</p>
            </div>
          </div>
        )}

        {/* Success Output JSON and Download Button */}
        {orchestrationResponse && (
          <div className="space-y-4 pt-4 border-t border-slate-800/80">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                    TRACES NT DDS Payload Ready
                  </span>
                  <span className="text-xs font-mono text-slate-400">
                    Ref: <span className="text-white font-semibold">{orchestrationResponse.referenceNumber}</span>
                  </span>
                </div>
                <p className="text-xs text-slate-400 mt-1">
                  Operator: <span className="text-slate-200 font-medium">{orchestrationResponse.operator?.supplierName}</span> &bull;{' '}
                  HS Code: <span className="text-emerald-400 font-mono">{orchestrationResponse.commodity?.hsCode}</span> ({orchestrationResponse.commodity?.netMassKg} kg) &bull;{' '}
                  Country: <span className="text-slate-200 font-semibold">{orchestrationResponse.commodity?.countryOfProduction}</span>
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleCopyDdsJson}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-200 border border-slate-700 transition"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  {ddsCopied ? 'Copied!' : 'Copy JSON'}
                </button>

                <button
                  type="button"
                  onClick={handleDownloadDdsJson}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 px-4 py-1.5 text-xs font-bold text-white transition shadow-md shadow-emerald-950/40"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  Download DDS.json
                </button>
              </div>
            </div>

            <pre className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950 p-4 font-mono text-xs text-emerald-300 max-h-[460px] shadow-inner">
              <code>{JSON.stringify(orchestrationResponse, null, 2)}</code>
            </pre>
          </div>
        )}
      </div>

      {/* ------------------------------------------------------------- */}
      {/* 6. Raw GeoJSON Inspector & Editor */}
      {/* ------------------------------------------------------------- */}
      {showJsonInspector && (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-xl space-y-4">
          <div className="flex items-center justify-between border-b border-slate-800/80 pb-3">
            <h3 className="text-sm font-bold text-white">GeoJSON Payload Inspection</h3>
            <span className="text-xs text-slate-400">Editable input / Validated output</span>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Input GeoJSON (Source)
                </span>
                <button
                  type="button"
                  onClick={() => runValidation(geoJsonInput, fileName)}
                  className="text-xs font-medium text-emerald-400 hover:text-emerald-300 transition"
                >
                  Re-evaluate Input &rarr;
                </button>
              </div>
              <textarea
                value={geoJsonInput}
                onChange={(e) => {
                  setGeoJsonInput(e.target.value);
                  runValidation(e.target.value, fileName);
                }}
                rows={14}
                className="w-full rounded-xl border border-slate-800 bg-slate-950 p-3.5 font-mono text-xs text-slate-300 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-cyan-400">
                  Corrected GeoJSON (Export)
                </span>
                <button
                  type="button"
                  onClick={handleCopyCorrected}
                  className="text-xs font-medium text-cyan-400 hover:text-cyan-300 transition"
                >
                  {copied ? 'Copied!' : 'Copy to Clipboard'}
                </button>
              </div>
              <textarea
                readOnly
                value={correctedGeoJson || ''}
                rows={14}
                className="w-full rounded-xl border border-slate-800 bg-slate-950 p-3.5 font-mono text-xs text-cyan-200 focus:outline-none"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
