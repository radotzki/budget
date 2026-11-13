# budget

A Google Cloud Function that answers a WhatsApp message with this week's card
spending. Twilio forwards each incoming WhatsApp message to the function over
HTTP; the function logs in to Max with Puppeteer (headless Chrome), adds up the
transactions since last Saturday, and replies through Twilio.

- Function name in Google Cloud: `budget`
- Entry point in the code: `incoming` (in `index.js`)
- Region: `us-central1`

## Run it locally

```sh
npm install
# create .env with the variables listed under "Environment variables"
npm start              # functions-framework on http://localhost:8080
npm test
```

## Deploy

```sh
npm run deploy
```

which runs:

```sh
gcloud functions deploy budget \
  --no-gen2 \
  --region=us-central1 \
  --runtime=nodejs22 \
  --entry-point=incoming \
  --trigger-http \
  --allow-unauthenticated \
  --memory=1024MB \
  --timeout=300s \
  --max-instances=1 \
  --source=.
```

Why each flag is there:

| Flag | Why |
| --- | --- |
| `budget` | The function's name, so its URL (the one Twilio calls) stays the same. |
| `--no-gen2` | 1st generation, to update the existing function in place. It was created in 2020, before 2nd gen existed, and `gcloud functions deploy` cannot switch a function's generation. Moving to 2nd gen is a separate step (see below). |
| `--region=us-central1` | Where the function lives. |
| `--runtime=nodejs22` | `package.json` needs Node `>=22.22.2` (israeli-bank-scrapers 6.13). Node 22 is the newest runtime 1st gen offers. |
| `--entry-point=incoming` | The exported handler. Without it gcloud uses the function name, `budget`, which the code doesn't export. |
| `--trigger-http` | Twilio calls the function over HTTP. Required when the function is created; on an update it keeps the trigger it has. |
| `--allow-unauthenticated` | Twilio's webhook sends no Google credentials, so the function has to accept unauthenticated calls to stay reachable by Twilio. See "Security" below. |
| `--memory=1024MB` | Headless Chrome doesn't fit in the 256MB default. If the logs show the function running out of memory, use `2048MB` (which also gives it more CPU). |
| `--timeout=300s` | Logging in and scraping takes about a minute; this leaves room. The 1st gen limit is 540s. |
| `--max-instances=1` | One household, one scrape at a time. Also caps the cost if someone else finds the URL. |
| `--source=.` | Uploads this folder. `.gcloudignore` keeps out `node_modules`, `.env`, `.env.yaml`, `.cache` and git files. |

Environment variables are deliberately not in the command: on an update, gcloud
keeps the function's existing variables. See below for a new function.

### Before you deploy, check

1. **You're in the right project:** `gcloud config get-value project`.
2. **The function's current state:**
   `gcloud functions describe budget --region=us-central1`.
   Note its `runtime`, `entryPoint`, `availableMemoryMb`, `environment`
   (`GEN_1` or `GEN_2`) and `httpsTrigger.url`. If it says `GEN_2`, change
   `--no-gen2` to `--gen2` before deploying. If it doesn't exist any more,
   see "Deploying a new function".
3. **Its environment variables are still set** (names under
   `environmentVariables` in the output above, see the list below).
4. **Twilio's webhook URL** (WhatsApp sandbox settings, "When a message comes
   in") is the `httpsTrigger.url` above. Deploying with the same name keeps it.

### After you deploy, check

1. Send the WhatsApp message. You should get the "מחשב נתונים" progress
   message, then the totals about a minute later.
2. If not, read the logs:
   `gcloud functions logs read budget --region=us-central1 --limit=50`.
   - A build failure mentioning the Node version means Google's nodejs22 is
     older than 22.22.2 right now; try again later, or move to 2nd gen and
     `nodejs24`.
   - `Failed for the following reason: <type>` is the scraper's error (for
     example a changed Max login page or wrong credentials).
   - "memory limit exceeded": raise `--memory` to `2048MB`.

Twilio waits only 15 seconds for the webhook to answer, and this function
answers after about a minute, so Twilio's console may log a timeout (error
11200) for each message even when the reply arrives: the replies are sent by
the function through Twilio's API, not as the webhook's response.

### Environment variables

The code reads these (locally from `.env`, in Google Cloud from the function's
settings). Keep the values out of git.

| Name | What |
| --- | --- |
| `TWILIO_ACCOUNT_ID` | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Twilio auth token |
| `MAX_USERNAME` | Max login |
| `MAX_PASSWORD` | Max password |
| `MAYS_CARD` | Card number (as Max reports it) for May's card |
| `ITAYS_CARD` | Card number for Itay's card |
| `SHARED_CRAD` | Card number for the shared card (the name's spelling is what the code reads) |
| `WHATSAPP_NUMBER` | Fallback recipient, `whatsapp:+972...`, used when a request has no `From` |

### Deploying a new function

If `budget` no longer exists, the same command creates it, but without
environment variables. Put them in `.env.yaml` (git-ignored and
gcloud-ignored), one `NAME: "value"` per line, and run:

```sh
npm run deploy -- --env-vars-file=.env.yaml
```

Then point Twilio's webhook at the new function's URL. For a brand-new
function you could also choose 2nd gen instead: replace `--no-gen2` with
`--gen2` (the memory value then reads as `1Gi`).

To change one variable later without touching the others:
`npm run deploy -- --update-env-vars=NAME=value`.

### Moving to 2nd gen later

1st gen tops out at Node 22, which reaches end of life on 2027-04-30. Google's
upgrade tool moves an HTTP function to 2nd gen and keeps its
`cloudfunctions.net` URL working:
`gcloud functions upgrade budget --region=us-central1 --setup-config`, then
`--redirect-traffic`, then `--commit` (see Google's "Upgrade 1st gen functions
to Cloud Run functions" guide). It needs a supported runtime first, which this
deploy gives it. After that, change `--no-gen2` to `--gen2` here.

## Security

The function is public because Twilio has to reach it, and the code doesn't yet
check Twilio's request signature, so anyone with the URL can trigger a scrape.
Keep the URL private. `--max-instances=1` limits what that costs.
