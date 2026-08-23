# Claims Auto-Fill Scripts

Tampermonkey userscripts that read order/refund data from **Deliveroo** or **Uber Eats**, then fill the **OpSpot Claims** form. You always click **Save** yourself — the scripts never submit the form.

---

## Files

| File | Platform |
|------|----------|
| `deliveroo-claims-autofill.user.js` | Deliveroo Partner Hub refunds |
| `ubereats-claims-autofill.user.js` | Uber Eats Manager orders |

---

## Setup (one-time)

1. Install **[Tampermonkey](https://www.tampermonkey.net/)** in Chrome (or Edge/Firefox).
2. In Chrome, open `chrome://extensions` → find Tampermonkey → turn on **Allow User Scripts** (and **Allow access to file URLs** if you load scripts from disk).
3. In Tampermonkey → **Dashboard** → **Utilities** → **Import from file**, or create a new script and paste the file contents.
4. Install **both** scripts if you use both platforms. They use separate buttons and storage, so they won’t overwrite each other.
5. Make sure each script is **Enabled**.

### OpSpot page

Open Claims at:

`https://opspot.workhorselive.com/sysTable.php?sys_module_id=10000&sys_data_entity_id=10000#`

Confirm the **Platform** dropdown includes **Deliveroo** and **Uber Eats**.

---

## Deliveroo workflow

1. Open the refund page on **Deliveroo Partner Hub**.
2. Click the teal button **Auto-Fill & Dispute** at the top of the page.
3. Check the on-screen preview (order number, amounts, reason, etc.).
4. Open **OpSpot Claims** → click **Add New**.
5. Click **Fill from Deliveroo**.
6. Review the form, then click **Save** (or **Save and Add New**).

---

## Uber Eats workflow

1. Open the order page on **Uber Eats Manager**  
   (e.g. `https://merchants.ubereats.com/manager/orders/...`).
2. Click the green button **Extract Order → OpSpot** at the top of the page.
3. Check the on-screen preview.
4. Open **OpSpot Claims** → click **Add New**.
5. Click **Fill from Uber Eats**.
6. Review the form, then click **Save**.

### What Uber Eats maps to OpSpot

| OpSpot field | Source on Uber Eats |
|--------------|---------------------|
| Order Number | Short order code (e.g. `6BAE4`) |
| Customer | Brand name (e.g. Burger King) |
| Location | Location in parentheses (e.g. Wellington Airport) |
| Claim Date | Order date |
| Order Time | “Order placed by customer” time |
| Order Value | Sales (incl. GST) |
| Dispute Amount | **Chargeback Amount** (absolute value) |
| Platform | Uber Eats |

Issue/refund reason is filled when it appears on the page (wrong order, food quality, food safety, **customization missing**, etc.). Customization missing maps to **Missing Item**. On a normal completed order with no issue section, reason fields may be empty — fill those manually if needed.

---

## Tips

- Use **one platform tab + one OpSpot tab**. Extract on the platform first, then fill on OpSpot.
- After **Save and Add New**, the script can refill the next claim if a new order was already extracted.
- If the fill button is missing, refresh the page or use Tampermonkey’s menu commands (**Fill from …** / **Extract Order**).
- If fields stay empty, open the Claims **Add New** modal first, then click Fill again.
- Deliveroo and Uber Eats buttons look different (teal vs green) and won’t clash on OpSpot.

---

## Troubleshooting

| Problem | What to try |
|---------|-------------|
| Button doesn’t appear | Confirm script is enabled; refresh; check URL matches (`partner-hub.deliveroo.com`, `merchants.ubereats.com`, or `opspot.workhorselive.com`) |
| “No stored order” on OpSpot | Run extract on the platform tab first, then Fill on OpSpot |
| Wrong / missing fields | Re-run extract; check the preview panel for `NOT FOUND` |
| Chrome blocks the script | Enable **Allow User Scripts** on the Tampermonkey extension |
| Platform dropdown empty / wrong | Confirm OpSpot has the exact options **Deliveroo** and **Uber Eats** |

---

## Notes

- Scripts only **read the page and fill the form**. They do **not** auto-submit disputes or claims.
- Data is stored temporarily in Tampermonkey storage (and optionally clipboard) between the platform tab and OpSpot.
