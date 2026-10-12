# GeoHeal EUDR GeoJSON Pre-Flight Checker

A client-side spatial validation suite built with [Astro](https://astro.build), [React](https://react.dev), [Tailwind CSS](https://tailwindcss.com), and [@turf/turf](https://turfjs.org) for European Union Deforestation Regulation (EUDR - Regulation (EU) 2023/1115) compliance.

## Features

- **Astro 7 + React 19 Integration**: Fast static output with interactive React islands.
- **Tailwind CSS v4**: Modern, sleek dark theme with glassmorphism header and emerald EUDR accents.
- **Client-Side Spatial Processing (`@turf/turf`)**: Zero-upload spatial calculations (area in hectares, coordinate sanity, bounding boxes, centroid diagnostics).
- **EUDR Ready**: Pre-flight checks for EPSG:4326 (WGS84 Lon/Lat), polygon winding, and &ge;4 ha polygon thresholds.

## Project Structure

```text
geoheal-validator/
├── public/
├── src/
│   ├── components/
│   │   └── PreflightChecker.tsx   # React Island using @turf/turf
│   ├── layouts/
│   │   ├── BaseLayout.astro       # Base dark-themed layout with header
│   │   └── Layout.astro           # Alias to BaseLayout
│   ├── pages/
│   │   └── index.astro            # Main pre-flight checker view
│   └── styles/
│       └── global.css             # Tailwind CSS v4 entrypoint
├── astro.config.mjs
├── package.json
└── tsconfig.json
```

## Getting Started

### Start Development Server
```bash
npm run dev
```

### Build for Production
```bash
npm run build
```

### Preview Production Build
```bash
npm run preview
```
