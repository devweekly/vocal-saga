# Express API on Netlify

A minimal Express.js REST API deployed as a Netlify Function using `serverless-http`.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/.netlify/functions/api/hello?name=YourName` | Returns a greeting |
| POST | `/.netlify/functions/api/echo` | Echoes back the JSON body |

## Tech Stack

- **Express.js** — HTTP routing and middleware
- **serverless-http** — adapts Express to the Netlify Functions handler format
- **Netlify Functions** — serverless compute

## Run Locally

```bash
npm install
netlify dev
```

Then visit `http://localhost:8888` or hit the API at `http://localhost:8888/.netlify/functions/api/hello`.
