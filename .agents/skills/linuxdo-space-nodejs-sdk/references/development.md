# Development Guide

## Workdir

```bash
cd sdk/nodejs
```

## Validate

```bash
npm ci
npm run build
npm test
```

## Release model

- Workflow file: `../../../.github/workflows/release.yml`
- Trigger: push tag `v*`
- Current release output is an `npm pack` tarball uploaded to GitHub Release
- There is no public npm registry publication in the current workflow

## Keep aligned

- `../../../package.json`
- `../../../src/index.ts`
- `../../../src/client.ts`
- `../../../src/types.ts`
- `../../../README.md`
- `../../../tests/client.test.mjs`
- `../../../.github/workflows/ci.yml`
- `../../../.github/workflows/release.yml`

