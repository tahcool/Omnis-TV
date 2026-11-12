# Omnis Auxiliary Screens

> This repository holds the **releases** the TV PCs update from (and a copy of the app source).
> The working copy is `apps/omnis-tv` in the main Omnis project, which also provides the shared screen page.

Stand-alone wall-screen app for the Fleetrack auxiliary screens - no Omnis login, no rest of the system.

| Screen | Shows |
|---|---|
| Daily Breakdown Report (DBR) | Open field breakdowns (responsibility FSD) |
| Work in Progress Report (WIP) | Open workshop breakdowns (responsibility WSD) |
| Major Defects Report (MDR) | Open Major defects (SRD rental customer excluded) |
| Service Tracking Summary (STS) | Fleetrack-managed machines by hours to service |
| Rotate all four | One TV that cycles DBR, WIP, MDR and STS |

The screen page is shared with the main app: `systems/fleetrack/kiosk.html` (copied in by `scripts/sync-screens.js`).

## How it gets data
TV PCs hold **no database keys**. The app calls the read-only Supabase Edge Function `tv-screens`
with a display PIN (header `x-tv-pin`). The function returns only open breakdowns, open major defects and
the machines the screens need. The PIN is stored on the TV PC encrypted with Windows DPAPI.

### One-time server setup
```powershell
# 1. Choose a PIN of at least 8 characters (several allowed, comma separated - e.g. one per site)
supabase secrets set TV_DISPLAY_PIN=<your-pin> --project-ref pfqaeewmlwfayxbgmuaq
# 2. Deploy (from C:\omnis-dev - supabase/functions is a junction to it)
cd C:\omnis-dev
supabase functions deploy tv-screens --no-verify-jwt --project-ref pfqaeewmlwfayxbgmuaq
```
To withdraw a PIN, set the secret again without it.

## Installing on a TV PC
1. Run `Omnis_Auxiliary_Screens_Setup_<version>.exe` (installs for the current Windows user, no admin needed).
2. Setup opens: enter the PIN, **Test connection**, choose a report (and division) per monitor,
   use **Identify monitors** to see which number is which TV, then **Save & start screens**.
3. It starts with Windows, keeps the displays awake, reloads a screen that crashes and refreshes
   every 60 seconds. If the server cannot be reached it keeps showing the last data with an "Offline" note.

Keys on a TV screen: **Ctrl+Shift+S** opens Setup, **Ctrl+Shift+Q** closes the screens.

## Building / releasing
```powershell
cd apps\omnis-tv
npm install --omit=dev          # once (electron-updater only)
node scripts\sync-screens.js
node ..\..\node_modules\electron-builder\cli.js --win --publish never     # -> dist\Omnis_Auxiliary_Screens_Setup_<version>.exe
```
App folder is `apps/omnis-tv`. Updates: the app checks GitHub releases of `tahcool/Omnis-TV` (separate from the main app's releases).
Bump `version` in this package.json, then publish with `--publish always` (needs `GH_TOKEN`).

Development run (local stand-in server): set `OMNIS_TV_ENDPOINT` and `OMNIS_TV_USERDATA`, then
`npx electron apps/omnis-tv` from the repo root. Both variables are ignored in the installed app.

