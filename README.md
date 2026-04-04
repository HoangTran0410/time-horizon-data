# time-horizon-data

All data of the Time Horizon project.

## Local Dev Server

To test external collections locally (without waiting for GitHub Pages to build):

```bash
node server.cjs           # port 5500 (default)
node server.cjs 8080      # custom port
```

Then update app's dev config (`src/hooks/useCatalogCollections.ts`) to `http://localhost:5500/data`
