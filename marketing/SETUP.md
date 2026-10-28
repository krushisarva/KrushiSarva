# One-time setup (founder)

This takes about half a day and is done once. **Only you can do it:**
- Google, Meta and Instagram forbid creating accounts with software.
- Sign-up needs your phone, an SMS or a CAPTCHA.

Do the steps in order. Some steps depend on earlier ones:
- the privacy page (§5) must exist before Google Cloud (§6) and the Meta app (§7);
- Google's consent screen must be **published** before you run `ksm auth-youtube`.

Tick each box as you go.

**What you need:**
- your phone (Telegram, Instagram, SMS codes);
- the krushisarva@gmail.com password;
- your own Facebook login;
- this Mac.

> **Tip: use a separate Chrome profile called "KrushiSarva"**, signed in only as
> krushisarva@gmail.com. Most setup mistakes come from a browser that is signed in to the wrong
> Google account.

---

## 1. Mac: disk, ffmpeg-full and the `ksm` command

- [ ] **Free at least 15 GB.** Run `df -h /` and look at the **Avail** column. Today it's about 9.8 GB.
  - The fastest wins are usually in System Settings → General → Storage.
  - `brew cleanup -s` also helps.
  - So do `~/Library/Developer/Xcode/DerivedData`, `~/.gradle/caches` and old iOS simulators.
  - Keep your Android emulator image, because you use it.
- [ ] **Install ffmpeg-full:**
  ```sh
  brew install ffmpeg-full
  /opt/homebrew/opt/ffmpeg-full/bin/ffmpeg -hide_banner -buildconf | grep -E 'libass|harfbuzz|freetype'
  ```
  You should see three `--enable-…` lines.
  - The plain `ffmpeg` you already have doesn't include libass, so it would silently break
    Marathi text.
  - ksm always uses the ffmpeg-full path. Leave the other ffmpeg installed.
- [ ] **Install the `ksm` command** (Python 3.12 from Homebrew):
  ```sh
  cd ~/Desktop/KrushiSarva/marketing
  /opt/homebrew/bin/python3.12 -m venv .venv
  .venv/bin/pip install -r requirements.lock
  .venv/bin/pip install -e . --no-deps
  source .venv/bin/activate        # `ksm` now works in this terminal
  ksm --help
  ```
  Every later step assumes you ran `source .venv/bin/activate` in your terminal first.

## 2. YouTube channel

Signed in as **krushisarva@gmail.com**:

- [ ] **Create the channel.**
  1. Go to youtube.com and click the avatar (top right) → **Create a channel**.
  2. Name: `KrushiSarva`. Handle: `@krushisarva`. If that handle is taken, pick the closest one and write it down.
  3. Click **Create channel**.
- [ ] **Phone-verify the channel.**
  1. Go to https://www.youtube.com/verify.
  2. Choose India → SMS → enter the code.
  - One phone number can verify at most **2 channels a year**, so don't use it on test channels.
- [ ] **Turn on 2-Step Verification.**
  1. Go to https://myaccount.google.com → **Security** → **2-Step Verification** → turn it on.
  2. Add a **recovery phone** and a **recovery email**.
  3. Save the backup codes in your password manager.
- [ ] **Set the channel defaults in YouTube Studio** (studio.youtube.com):
  1. Customisation → Profile: upload the KrushiSarva mark (`frontend/assets/splash-mark.png` works). Write a short Marathi description.
  2. Settings → Channel → Basic info: set Country to **India**.
  3. Settings → Channel → Advanced settings: choose "No, set this channel as not made for kids".

## 3. Facebook Page and business portfolio

- [ ] **Create the Page from your own real profile.** Facebook requires a real-name personal account, and Pages are created from one.
  1. On facebook.com, open the Menu → **Pages** → **Create new Page**.
  2. Name: `KrushiSarva`. Category: something like *Agriculture*. Bio in Marathi.
  3. Click **Create Page**.
  4. Add the profile picture and cover.
- [ ] **Create the business portfolio.**
  1. Go to https://business.facebook.com/overview → **Create an account** (also called "Create a business portfolio").
  2. Portfolio name: `KrushiSarva`. Your name. Business email: **krushisarva@gmail.com**.
  3. Submit.
  4. Open the confirmation email in the krushisarva Gmail inbox and confirm.
- [ ] **Add the Page to the portfolio.**
  1. Go to https://business.facebook.com/settings.
  2. **Accounts → Pages → Add → Add a Page** → choose KrushiSarva.
- [ ] **Add a second human admin**, so the brand isn't lost if your own profile is ever locked.
  1. Business settings → **Users → People → Add**.
  2. Enter their email and give them **Full control**.
  3. Assign the KrushiSarva Page with full control.
  4. They must accept the invite.
- [ ] **Turn on 2FA** on your Facebook profile: Accounts Center → Password and security → Two-factor authentication.

## 4. Instagram Business account

- [ ] **Sign up.** In the Instagram app, go to Add account → **Create new account**.
  - Email: krushisarva@gmail.com.
  - Username: `krushisarva`.
- [ ] **Switch it to a Business account.**
  1. Go to Profile → ☰ → **Settings and activity** → **Account type and tools** → **Switch to professional account**.
  2. Choose **Business** and a farming or agriculture category.
- [ ] **Link it to the KrushiSarva Page.** Switch into the Page on facebook.com → Settings → **Linked accounts** → Instagram → **Connect account** → log in as krushisarva.
  - Meta moves these menus around. If you can't find it, search the settings for "linked accounts".
- [ ] **Add it to the portfolio.** Business settings → **Accounts → Instagram accounts → Add** → log in as krushisarva.
  - An Instagram account can belong to only one portfolio.
- [ ] **Turn auto-share to Facebook OFF.**
  1. Go to Instagram → Settings and activity → **Accounts Center** → **Sharing across profiles**.
  2. Choose krushisarva → Facebook.
  3. Turn off automatic sharing of **Reels** (and posts and stories).
  - We post to Facebook separately, so leaving this on would post every Reel twice.
- [ ] **Turn on 2FA:** Accounts Center → Password and security → Two-factor authentication.

## 5. Privacy page on Google Sites (blocks going live)

YouTube and Meta both require a public privacy page. The app's own `/legal` pages are still gated
(`LEGAL_DOCS_APPROVED=false`), so for now we use Google Sites. The English text comes from
`PRIVACY.md`.

- [ ] **Create the site.** Signed in as krushisarva@gmail.com, go to https://sites.google.com → **+ Blank site**.
- [ ] Site name: `KrushiSarva Publisher`. Page title: `Privacy / गोपनीयता`.
- [ ] **Paste the text.** Use Insert → **Text box** and paste the text below. Select each URL and press ⌘K to make it a link (Sites sometimes does this by itself).
- [ ] **Publish.**
  1. Click **Publish** (top right).
  2. Web address: `krushisarva-publisher`. Under "Who can view", choose **Anyone**.
  3. Click **Publish**.
- [ ] **Check it.** Open `https://sites.google.com/view/krushisarva-publisher` in a **private window** and confirm it loads without a login. Save this URL. You need it in §6 and §7.

**Text to paste:**

```text
KrushiSarva Publisher — गोपनीयता सूचना / Privacy notice
शेवटचा बदल / Last updated: 16 October 2026

━━━━━━━━━━━━━━━━ मराठी ━━━━━━━━━━━━━━━━

हे साधन काय आहे
KrushiSarva Publisher हे KrushiSarva चे अंतर्गत साधन आहे. ते एकाच संगणकावर चालते आणि शेतकऱ्यांसाठी छोटे मराठी व्हिडिओ तयार करते. KrushiSarva मधील व्यक्तीने प्रत्येक व्हिडिओ मंजूर केल्यानंतरच तो KrushiSarva च्या स्वतःच्या YouTube चॅनेल, Facebook पेज आणि Instagram खात्यावर प्रकाशित होतो. हे साधन सार्वजनिक वापरासाठी नाही; KrushiSarva बाहेरील कोणीही त्यात लॉग-इन करू शकत नाही.

कोणाची माहिती
फक्त KrushiSarva च्या स्वतःच्या खात्यांची. प्रेक्षक, फॉलोअर्स, कमेंट करणारे किंवा KrushiSarva ॲपचे वापरकर्ते यांची कोणतीही माहिती हे साधन गोळा करत नाही, घेत नाही किंवा साठवत नाही.

हे साधन काय वापरते
• KrushiSarva च्या YouTube चॅनेलचे (YouTube API Services) आणि Facebook पेज व Instagram खात्याचे (Meta Graph API) ॲक्सेस टोकन. ते प्रकाशन करणाऱ्या संगणकावर macOS Keychain मध्ये सुरक्षित ठेवले जातात. त्यांचा वापर फक्त मंजूर व्हिडिओ अपलोड करणे, त्यांची वेळ व दृश्यता ठरवणे आणि आमच्या स्वतःच्या चॅनेल/पेजची आकडेवारी वाचणे यासाठी होतो.
• आमच्या स्वतःच्या व्हिडिओंची आणि खात्यांची एकूण आकडेवारी: व्ह्यूज, पाहण्याचा वेळ, लाइक्स, शेअर्स, सेव्ह आणि फॉलोअर्सची संख्या. यात कोणत्याही एका प्रेक्षकाची माहिती नसते.
• मंजुरी देणाऱ्या व्यक्तीचा Telegram user ID, जेणेकरून फक्त तीच व्यक्ती मंजुरी देऊ शकेल.
• सार्वजनिक सरकारी माहिती: Agmarknet बाजारभाव (data.gov.in), हमीभाव (PIB) आणि अधिकृत कृषी सल्ला.
• व्हिडिओची स्क्रिप्ट मसुदा व तपासणीसाठी Anthropic (Claude) कडे, आणि निवेदनाचा मजकूर AI आवाज तयार करण्यासाठी Sarvam AI कडे पाठवला जातो. त्यात कोणतीही वैयक्तिक माहिती नसते.

हे साधन काय करत नाही
माहिती विकत नाही. जाहिरात किंवा टार्गेटिंगसाठी वापरत नाही. KrushiSarva ॲपमध्ये शेतकऱ्यांनी अपलोड केलेले फोटो, पीक-स्कॅन किंवा इतर काहीही वापरत नाही. कमेंट्स किंवा खाजगी मेसेज वाचत नाही. कोणाच्याही डिव्हाइस किंवा ब्राउझरवर कुकीज (cookies) किंवा तत्सम तंत्रज्ञान ठेवत नाही, वाचत नाही आणि इतर कोणालाही तसे करू देत नाही.

YouTube आणि Google
हे साधन YouTube API Services वापरते.
YouTube सेवा अटी: https://www.youtube.com/t/terms
Google गोपनीयता धोरण: https://policies.google.com/privacy
Google खात्यातून या साधनाचा ॲक्सेस काढून घेण्यासाठी: https://security.google.com/settings/security/permissions

साठवण आणि कालावधी
सर्व माहिती KrushiSarva च्या मालकीच्या एकाच Mac संगणकावर राहते. व्हिडिओ फाइल्स आपोआप हटवल्या जातात: तात्पुरत्या फाइल्स गुणवत्ता तपासणीनंतर, प्रिव्ह्यू निर्णयानंतर १ दिवसाने आणि अंतिम व्हिडिओ सर्व प्लॅटफॉर्मवर प्रकाशित झाल्यानंतर ३ दिवसांनी. YouTube API Services मधून मिळालेली माहिती YouTube च्या Developer Policies नुसार अद्ययावत केली जाते किंवा हटवली जाते.

माहिती हटवण्याची विनंती (Facebook, Instagram, YouTube)
krushisarva@gmail.com वर "Data deletion request" या विषयाने ई-मेल करा. आम्ही ३० दिवसांच्या आत माहिती हटवू आणि ई-मेलने कळवू. हे साधन फक्त KrushiSarva ची स्वतःची खाती हाताळते, त्यामुळे इतर कोणाचीही माहिती आमच्याकडे नसते; अशी विनंती आल्यास आम्ही तसे लेखी कळवू.
Facebook वरून ॲक्सेस काढण्यासाठी: Settings & privacy → Settings → Business integrations → ॲप निवडा → Remove.

संपर्क
krushisarva@gmail.com

━━━━━━━━━━━━━━━━ English ━━━━━━━━━━━━━━━━

What the tool is
KrushiSarva Publisher is an internal tool that KrushiSarva runs on one computer. It makes short Marathi videos for farmers. It posts each video to KrushiSarva's own YouTube channel, Facebook Page and Instagram account only after a person at KrushiSarva approves that video. The public can't use it, and nobody outside KrushiSarva can sign in to it.

Whose data it handles
It handles data about KrushiSarva's own accounts only. It does not collect, receive or store information about viewers, followers, commenters, or users of the KrushiSarva app.

What it uses
• Access tokens for KrushiSarva's YouTube channel (YouTube API Services) and for KrushiSarva's Facebook Page and Instagram account (Meta Graph API). They are kept in the macOS Keychain on the publishing computer. They are used only to upload approved videos, set their visibility and schedule, and read our own channel and Page statistics.
• Statistics for our own videos and accounts: views, watch time, likes, shares, saves and follower counts. These are totals only and never include anything about an individual viewer.
• The approver's Telegram user ID, so that only that person can approve a video.
• Public government data: Agmarknet mandi prices (data.gov.in), Minimum Support Prices (PIB) and official agricultural advisories.
• The video script is sent to Anthropic (Claude), which drafts and checks it. The narration text is sent to Sarvam AI, which turns it into the AI voice. Neither contains personal data.

What it does not do
It does not sell data. It does not use data for advertising or targeting. It never uses photos, crop scans or anything else that farmers upload to the KrushiSarva app. It does not read comments or private messages. It does not place, read or recognise cookies or similar technology on anyone's device or browser, and it does not let third parties do so.

YouTube and Google
KrushiSarva Publisher uses YouTube API Services.
YouTube Terms of Service: https://www.youtube.com/t/terms
Google Privacy Policy: https://policies.google.com/privacy
To remove this tool's access to a Google account: https://security.google.com/settings/security/permissions

Storage and retention
Everything stays on one Mac that KrushiSarva owns. Video files are deleted automatically: working files once a video passes its quality check, previews 1 day after the approver decides, and final videos 3 days after they are published on every platform. Data obtained through YouTube API Services is refreshed or deleted as the YouTube API Services Developer Policies require.

Data deletion (Facebook, Instagram, YouTube)
To ask for deletion, email krushisarva@gmail.com with the subject "Data deletion request". We delete the data within 30 days and confirm by email. The tool processes only KrushiSarva's own accounts, so it holds no data about anyone else. If you are not KrushiSarva and you ask, we will reply in writing to confirm that.
To remove the app's access on Facebook: Settings & privacy → Settings → Business integrations → select the app → Remove.

Contact
krushisarva@gmail.com
```

## 6. Google Cloud: YouTube API access

Signed in as **krushisarva@gmail.com** (check the avatar, top right):

- [ ] **Create the project.**
  1. Go to https://console.cloud.google.com and accept the terms if asked.
  2. Open the project picker → **New project**. Name: `ksm-publisher` → **Create**.
  3. Select the new project.
- [ ] **Enable the APIs.** Go to **APIs & Services → Library** and enable:
  - **YouTube Data API v3**;
  - **YouTube Analytics API**.
- [ ] **Configure the consent screen.**
  1. Go to **Google Auth Platform** (the old "OAuth consent screen" menu opens it) → **Get started**.
  2. App name: `KrushiSarva Publisher`. User support email: krushisarva@gmail.com → Next.
  3. Audience: **External** → Next.
  4. Contact email: krushisarva@gmail.com → Next.
  5. Agree to the user data policy → **Create**.
- [ ] **Branding** → add the privacy policy link (your Google Sites URL) → Save.
  - If the form refuses it because of an "unauthorised domain", leave it blank. Google only checks it for app verification, which we don't need for a single-owner tool.
- [ ] **Publish the app.** This is the step people skip, and the whole setup breaks if you skip it.
  1. Go to **Audience**. The publishing status says "Testing".
  2. Click **Publish app** → **Confirm**. The status should now say **In production**.
  3. Don't add test users.
  - In Testing, Google kills the refresh token after 7 days.
- [ ] **Create the Desktop client.**
  1. Go to **Clients** → **Create client**.
  2. Application type: **Desktop app**. Name: `ksm-mac` → **Create**.
  3. Click **Download JSON**.
- [ ] **Store the client JSON in the Keychain**, then delete the download:
  ```sh
  ls ~/Downloads/client_secret_*.json            # must list exactly ONE file; delete older ones first
  pbcopy < ~/Downloads/client_secret_*.json      # the file is one line
  ksm secrets set youtube_client_json            # paste when asked, then Enter
  rm ~/Downloads/client_secret_*.json
  ```
  With two files there, the paste would be both files glued together, and `ksm auth-youtube` would reject it.
- [ ] **Authorise the channel.** Do this as the account that owns the channel. A manager invited through YouTube Studio can't use the API.
  1. Make sure the browser that opens is the KrushiSarva profile. If not, copy the printed link into it.
  2. Run `ksm auth-youtube`.
  3. Pick **krushisarva@gmail.com**, then pick the **KrushiSarva** channel if Google asks.
  4. You'll see "Google hasn't verified this app". Click **Advanced** → **Go to KrushiSarva Publisher (unsafe)**. This warning is expected for a private tool.
  5. **Tick every permission box**. If Google asks how long to allow access, choose the option **with no end date**, because time-limited access kills the token when it runs out. Then click Continue.
  6. The terminal prints the channel title and ID. If it isn't KrushiSarva, run `ksm auth-youtube` again and pick the right channel.
  - If you ever authorised while the app was still in Testing, run `ksm auth-youtube` again now. That old token dies in 7 days.

## 7. Meta app and system user (Facebook + Instagram API)

- [ ] **Register as a developer.** Log in at https://developers.facebook.com with your own Facebook account. The first time, use **Get started** to register and verify your phone.
- [ ] **Create the app.**
  1. Go to **My Apps → Create app**.
  2. Name: `KrushiSarva Publisher`. Contact email: krushisarva@gmail.com.
  3. Use case: **Other** → App type: **Business**.
  4. Business portfolio: **KrushiSarva** → Create.
- [ ] **Add the products.**
  - **Facebook Login for Business**;
  - **Instagram → API setup with Facebook login**;
  - **Pages** (if listed separately);
  - **Marketing API**. Adding it automatically grants the "Limited" Marketing API access tier (formerly "Ads Management Standard Access"). That tier is what lets the portfolio create one admin system user and its token.

  If the dashboard shows **Use cases** instead of Products, add the matching ones: managing a Page, Instagram content with Facebook login, and the Marketing API.
- [ ] **Fill in App settings → Basic**, then Save:
  - App icon: 1024×1024 PNG. The KrushiSarva mark is fine.
  - Privacy policy URL: your Google Sites URL.
  - User data deletion: **Data deletion instructions URL** = the same Google Sites URL.
  - Category: business.
- [ ] **Switch the app to Live.** Use the top-bar App Mode toggle, Development → **Live**, or **Publish**.
  - While the app is in Development, its posts are visible only to people with a role on the app.
  - Stay on Standard Access. App Review and Business Verification aren't needed, because the app only touches our own Page and Instagram account.
- [ ] **Create the system user.**
  1. Go to https://business.facebook.com/settings → **Users → System users → Add**.
  2. Name: `ksm-publisher`. Role: **Admin** → Create.
- [ ] **Assign assets to the system user.** Select `ksm-publisher` → **Assign assets**, then:
  - Pages → KrushiSarva → **Full control**;
  - Instagram accounts → krushisarva → **Full control**;
  - Apps → KrushiSarva Publisher → **Full control** (manage app).

  Save.
- [ ] **Generate the token.**
  1. Click **Generate token** → choose the app KrushiSarva Publisher.
  2. Token expiration: **Never**.
  3. Tick exactly these permissions:
     - `instagram_basic`
     - `instagram_content_publish`
     - `instagram_manage_insights`
     - `pages_show_list`
     - `pages_read_engagement`
     - `pages_manage_posts`
     - `read_insights`
     - `business_management`
     - `ads_read`
  4. Click **Generate** and copy the token. Meta shows it only once.
- [ ] **Store the token:** `ksm secrets set meta_system_user_token` → paste → Enter.
  - Never paste it anywhere else: chat, notes or email.
  - If Meta says the app needs review before it can issue the token, take a screenshot and stop. Meta's docs contradict each other on this point, and it needs a look before you click anything else.

## 8. Telegram approval bot

- [ ] **Create the bot.**
  1. In Telegram on your phone, open **@BotFather** (blue tick) → `/newbot`.
  2. Name: `KrushiSarva Approvals`.
  3. Username: anything ending in `bot`, for example `krushisarva_approval_bot`.
  4. BotFather replies with a token like `123456789:AA…`.
- [ ] **Optional hardening:** `/setjoingroups` → choose the bot → **Disable**, so nobody can add it to a group.
- [ ] **Store the token on the Mac:** `ksm secrets set telegram_bot_token` → paste the token.
- [ ] **Pair your phone.**
  1. Run `ksm pair-telegram`. It prints a line like `/start K7QM2XPA9D` (10 letters and digits).
  2. Open your bot's **private** chat (`t.me/<username>`, not a group) and send exactly that line.
     - The code works once and expires after **15 minutes**. If the bot replies that it is wrong or old, run `ksm pair-telegram` again.
  3. The bot replies ✅ and stores your Telegram ID. From now on, **only that ID** can tap the buttons.
- If the bot token ever leaks: send `/revoke` to BotFather, then run `ksm secrets set telegram_bot_token` again with the new token.

## 9. API keys into the Keychain

Each `ksm secrets set <name>` asks you to paste the value. Nothing is written to a file.

- [ ] **Anthropic.** Use a **separate** key so marketing spend shows up on its own.
  1. In https://console.anthropic.com, create a workspace called `marketing`.
  2. Under API keys, create a key in that workspace.
  3. Run `ksm secrets set anthropic_api_key`.
  - Optional backstop: set a monthly spend limit on that workspace a little above ₹1,500.
- [ ] **Sarvam.**
  1. Go to https://dashboard.sarvam.ai → API keys → create a key.
  2. Run `ksm secrets set sarvam_api_key`.
  3. Add some credit. The voice costs about ₹150 a month.
- [ ] **data.gov.in.**
  1. Register or sign in at https://data.gov.in → My Account → generate an API key.
  2. Run `ksm secrets set datagov_api_key`.
- [ ] **Pexels.** It's free and needed from milestone M3, but you can set it now.
  1. Go to https://www.pexels.com/api, sign up with krushisarva@gmail.com and describe the use.
  2. Run `ksm secrets set pexels_api_key`.

## 10. Mac: keep it available

- [ ] **Energy settings.**
  - MacBook: System Settings → **Battery → Options…** → turn on "Prevent automatic sleeping on power adapter when the display is off". Also turn on **Wake for network access**.
  - Desktop Mac: the same switches are under System Settings → **Energy**.
  - Keep a MacBook on the charger with the lid open.
- [ ] **Optional morning wake**, so Instagram can post at 07:00 even if the Mac fell asleep overnight:
  ```sh
  sudo pmset repeat wakeorpoweron MTWRFSU 06:30:00
  pmset -g sched            # check it is listed
  # undo: sudo pmset repeat cancel
  ```
  Day 0 (§11) checks whether a scheduled wake actually gets network.
- [ ] **Stay logged in.** The background agent runs only inside your login session.
  - Locking the screen is fine.
  - Logging out stops it.
  - After a restart it starts again once you log in.
- It's normal that rendering pauses while the Android emulator runs or macOS reports memory pressure.

## 11. Install, check, day 0

- [ ] **Install the agent:** `ksm install --load`.
  - This copies the code, config, fonts and allow-listed brand art into `~/Library/Application Support/ks-marketing/`, then installs and loads the background agent. macOS blocks background processes from reading `~/Desktop`, so the agent runs from that copy.
  - **Re-run it after every `git pull` and after every config edit.**
- [ ] **Check everything:** `ksm doctor`, then `ksm doctor --live`. Every line should say OK.
  - `ksm doctor` checks this Mac: ffmpeg's libass, the font hashes, reading Keychain secrets without a prompt, disk, memory and the agent's state.
  - `--live` also calls the services: Telegram `getMe`, your YouTube channel ID, the Meta scopes and the Page and Instagram IDs, and data.gov.in, Sarvam and Anthropic.

  Fix anything red using README.md → Troubleshooting.
- [ ] **Run the live tests:** `ksm day0 --yes`. It makes **real test posts** and lists what it did:
  - a YouTube unlisted upload that is then made public;
  - a Facebook Reel scheduled 15 minutes ahead;
  - a check of the Facebook AI flag;
  - an Instagram Reel;
  - a Telegram round trip;
  - Sarvam voice samples;
  - Claude structured output;
  - a check of the scheduled wake.

  While it runs:
  1. Keep Telegram open and tap the test buttons when they arrive.
  2. Open the test Facebook and Instagram Reels from an account that is **not** an admin, such as a family member's phone, and confirm they're public.
  3. If YouTube says the test video is **locked as private**:
     - delete it;
     - file the audit the same day at https://support.google.com/youtube/contact/yt_api_form. Use case: "Internal Company Tool" + "Video Uploading & Account Management". Use your privacy page URL;
     - meanwhile run with Facebook and Instagram only.
  4. Delete the test posts afterwards if day0 tells you it didn't.

## 12. One-time confirmations

- [ ] **Brand spelling for the voice.**
  1. Open `config/pronunciation.yaml`. The entry `KrushiSarva → कृषीसर्व` has `confirmed: false`.
  2. Fix the Devanagari if it's wrong, then set `confirmed: true`.
- [ ] **Voice.** Day 0 sends Sarvam voice samples to Telegram. Pick one.
  - The default is `mrunal_mr_narration` (Sarvam `bulbul:v4-flash`, 48 kHz).
  - If you prefer another, for example `soham_mr_narration`, it has to be changed before the dry-run week.
- [ ] **Rabi advisories.** This is the biggest one-time content task. Every entry in `config/advisories.yaml` starts as `verified: false`, and the evening रब्बी पेरणी series **makes nothing** until entries are verified. For each entry:
  1. Read the listed university, KVK or IMD source.
  2. Put the exact page URL in `sources`.
  3. Correct the facts if needed.
  4. Set `verified: true`, `verified_by: <name>` and `verified_on: YYYY-MM-DD`.
- [ ] Glance at `config/msp.yaml`. Every row has an official source link. Check that the numbers match the PIB release.
- [ ] Run `ksm install --load` again so the installed copy picks up these edits.

## 13. Dry-run week, then live

- [ ] **Dry-run week.** For 7 days, approve cards on Telegram as you normally would.
  - `config/settings.yaml` ships with `dry_run: true` and `platforms: ["yt"]`, so nothing is actually posted; the publishers only log what they would do.
  - The week measures slot hit rate, cost per video, disk change and sleep gaps. Check `ksm report`.
- [ ] **Go live on YouTube.** In `config/settings.yaml`, set `dry_run: false`, then run `ksm install --load`.
- [ ] **Add Facebook and Instagram** once the Meta day-0 checks have passed: set `platforms: ["yt", "fb", "ig"]`, then run `ksm install --load`.
- [ ] **Check the first real posts.** Open each one from a non-admin account to confirm it's public, and watch Telegram for alerts.

Done. From here on, your daily work is the approval tap. See README.md → "Your day".
