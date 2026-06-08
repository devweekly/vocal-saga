# AGENTS.md

## Project Architecture

A single-function Express.js API deployed on Netlify Functions.

```
/
├── netlify/
│   └── functions/
│       └── api.mjs         # Express app wrapped with serverless-http
├── public/
│   └── index.html          # Static landing page
├── netlify.toml            # Build config; esbuild bundler for functions
└── package.json
```

## Key Decisions

- **`serverless-http`** bridges Express's `req/res` model to the AWS Lambda-style handler that Netlify Functions expect. All Express middleware, routing, and error handling works as normal.
- **`esbuild` bundler** (`netlify.toml`) is required so that `node_modules` (express, serverless-http) are bundled into the function at deploy time.
- **`type: "module"`** in `package.json` — functions use ESM (`.mjs`). The handler is exported as a named export (`export const handler`), which is what `serverless-http` + Netlify expects.
- Static files live in `public/` (configured as the publish directory).

## Coding Conventions

- Add new routes directly in `netlify/functions/api.mjs` using standard Express syntax.
- Keep middleware registration before route definitions.
- Always respond with `res.json()` for API routes.
- Use `Netlify.env.get('VAR')` (not `process.env`) if you need environment variables inside functions.
