# KrushiSarva Publisher: privacy notice

Last updated: 28 October 2026

This is the publisher privacy notice for **KrushiSarva Publisher** (the `ksm` tool in this
folder). YouTube's API Developer Policies and Meta's app settings both require a public privacy
page. The text below is the source for that page. SETUP.md §5 has a paste-ready Marathi + English
version for Google Sites. If you change this file, update the Google Sites page as well.

---

## What the tool is

KrushiSarva Publisher is an internal tool that KrushiSarva runs on one computer. It makes short
Marathi videos for farmers. It posts each video to KrushiSarva's **own** YouTube channel, Facebook
Page and Instagram account only after a person at KrushiSarva approves that video. The public
can't use it, and nobody outside KrushiSarva can sign in to it.

## Whose data it handles

It handles data about KrushiSarva's own accounts only. It does not collect, receive or store
information about viewers, followers, commenters, or users of the KrushiSarva app.

## What it uses

| Data | Why | Where it is kept |
|---|---|---|
| Access tokens for KrushiSarva's YouTube channel (YouTube API Services) and for KrushiSarva's Facebook Page and Instagram account (Meta Graph API) | To upload approved videos, set their visibility and schedule, and read our own channel and Page statistics | macOS Keychain on the publishing computer |
| Statistics for our own videos and accounts: views, watch time, likes, shares, saves and follower counts | To learn which videos help farmers most | A local database on the publishing computer |
| The approver's Telegram user ID | So that only that person can approve a video | A local database on the publishing computer |
| Public government data: Agmarknet mandi prices (data.gov.in), Minimum Support Prices (PIB) and official agricultural advisories | The facts in each video | A local database on the publishing computer |

The statistics are totals only. They never include anything about an individual viewer.

To make each video, the tool sends:
- the script to **Google (Gemini API, free tier)**, which drafts and checks it;
- the narration text to **Sarvam AI**, which turns it into the AI voice.

Scripts and narration are built only from public government data and contain no personal data.
On the Gemini API's free tier, Google may use what is sent to improve its products, and people at
Google may read it. Gemini API terms: https://ai.google.dev/gemini-api/terms

## What it does not do

- It does not sell data or share it with anyone except the services named above.
- It does not use data for advertising or targeting.
- It never uses photos, crop scans or anything else that farmers upload to the KrushiSarva app.
- It does not read comments or private messages.
- It has no website or app for the public. It does not place, read or recognise cookies or
  similar technology on anyone's device or browser, and it does not let third parties do so.

## YouTube and Google

KrushiSarva Publisher uses YouTube API Services.

- YouTube Terms of Service: https://www.youtube.com/t/terms
- Google Privacy Policy: https://policies.google.com/privacy
- To remove this tool's access to a Google account: https://security.google.com/settings/security/permissions

## Storage and retention

Everything stays on one Mac that KrushiSarva owns. Video files are deleted automatically:
- working files once a video passes its quality check;
- previews 1 day after the approver decides;
- final videos 3 days after they are published on every platform.

Data obtained through YouTube API Services is refreshed or deleted as the YouTube API Services
Developer Policies require.

## Data deletion (Facebook, Instagram, YouTube)

To ask for deletion, email **krushisarva@gmail.com** with the subject "Data deletion request".
We delete the data within 30 days and confirm by email.

The tool processes only KrushiSarva's own accounts, so it holds no data about anyone else. If you
are not KrushiSarva and you ask, we will reply in writing to confirm that.

To remove the app's access yourself:
- **Facebook:** Settings & privacy → Settings → Business integrations → select the app → Remove.
- **Google:** use the link in the YouTube and Google section above.

## Contact

krushisarva@gmail.com

## Changes

If this notice changes, we update this page and the date at the top.
