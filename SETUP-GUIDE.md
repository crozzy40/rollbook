# Rollbook — setting up your own copy

Two accounts, about 30 minutes total, and you own everything: the app, the data, and the money.

- **Render** hosts the app. About $7.25 a month. Do this today.
- **Stripe** moves rent from tenants' banks to yours. No monthly fee. Do this today too, so it's verified by the time online payments arrive.

You do not need a GitHub account or any technical setup. Ryan has already published the app; you just click a link.

---

## Part 1 — Render (15 minutes)

1. Go to **render.com** and click **Get Started**. Sign up with your email (don't use "Sign up with GitHub"). Confirm the email.
2. Add a card: top-right menu → **Billing** → **Add payment method**. Nothing is charged until step 5.
3. Open the deploy link Ryan sends you (it starts with `https://render.com/deploy?repo=`). Render shows a page with one service named **rollbook**.
4. Give the blueprint any name (e.g. "Rollbook") and click **Apply**. Render builds the app, which takes one to two minutes. When the service shows a green **Live**, it's running.
5. Click the service and copy its address (it ends in `.onrender.com`). That address is your Rollbook. Bookmark it on your computer and your phone.

What you're paying for: the app (Starter, $7/month) plus one gigabyte of storage where your data lives ($0.25/month). Render bills monthly to the card on file.

## Part 2 — First time in Rollbook (10 minutes, then the imports)

1. Open your address. It asks you to **set a password**. Choose one you'll remember; there's no "forgot password" link because there's only one account. Write it down somewhere safe.
2. Leave **demo portfolio** checked the first time so you can click around with fake buildings. When you're ready for real data, **Settings → Clear demo data** removes them.
3. **Settings**: set your rent due day, grace days, and late fee amount. Save.
4. **Import workbook**: drag in one of your building files. Check the building name and year, type the unit number next to each tenant, click **Save to Rollbook**. Repeat for each building. Fourteen files takes under an hour.
5. Open **Who owes**. That's the report, and it stays current on its own from here.

Every payment you receive: **Units** → tap the unit → the amount is pre-filled → choose how they paid → **Record payment**.

Once a month: **Export → Download backup**. Keep the file. It's your whole book in one file.

## Part 3 — Stripe (10 minutes now, a day or two to verify)

1. Go to **stripe.com** and click **Start now**. Use the same email as your bookkeeping.
2. Stripe asks about your business. Answer as the entity that owns the buildings: your LLC's name and EIN, or your own name and SSN if you hold them personally. Add the bank account rent should land in.
3. Stripe verifies you, usually within a day. You'll get an email when it's done.
4. Once verified: in the Stripe dashboard, **Settings → Payments → Payment methods**, and turn on **ACH Direct Debit** (bank payments). It's off by default and it's the cheap one.
5. In Rollbook: **Settings → Online payments**. From the Stripe dashboard, **Developers → API keys**, copy the **Secret key** and paste it in. Then **Developers → Webhooks → Add endpoint**: paste the Endpoint URL that Rollbook shows you, pick the four `checkout.session` events it lists, and copy the **Signing secret** into the second field. Click **Save and test the connection**. Ryan never needs these keys.
6. Try it before telling tenants: Stripe has a **Test mode** switch; use its test secret key first (it starts with `sk_test_`), open one of your own pay links, and pay with Stripe's fake bank account (account `000123456789`, routing `110000000`). When it lands on the ledger, switch to the live key.
7. Each tenant's private pay link is on their unit page. Text it or email it once; they can bookmark it.

## Part 4 — Repair requests (nothing to set up)

The same link tenants pay from also lets them report a repair, with photos taken on their phone. Those land in **Work orders**, newest emergencies first, and the menu shows a count until you look. You can type a line they'll see next to it ("Plumber coming Thursday"), and marking it done tells them it's fixed and offers to log the cost as an expense.

Two things worth doing once, in **Settings → Repair requests**: leave the form switched on, and add the phone number you want a tenant to call for a true emergency (flooding, no heat, gas). They'll see it the moment they pick Emergency.

What it costs: nothing monthly. A bank payment costs 0.8% capped at $5, so a $3,500 rent costs $5. A card payment costs 2.9% plus 30¢ (about $102 on $3,500), which is why bank payments will be the default and cards optional. If a tenant's bank payment bounces, Stripe charges $4 for the failed attempt, the same way a bounced check costs you a fee.

---

## Later: updates and help

- When Ryan releases an update, he'll tell you. You apply it in Render: open the **rollbook** service → **Manual Deploy** → **Deploy latest commit**. Nothing changes on its own.
- If you'd like Ryan to be able to do that for you and look at logs when something's off: Render → **Settings → Team** → invite his email. You can remove him any time. He still can't see your Rollbook password or log in as you.
- If the app ever shows "Something went wrong", reload. If it keeps happening, send Ryan the time it happened; the service's **Logs** tab in Render has the details.

Rollbook was built for you by NormalGuyAI.
