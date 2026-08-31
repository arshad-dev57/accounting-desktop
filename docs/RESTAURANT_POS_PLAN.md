# Restaurant POS Flow — Plan (Flow #2) — v3

> **Retail (Flow #1):** unchanged — `sell.js`, local sale → Sync.  
> **Restaurant (Flow #2):** separate mode — no draft, no WiFi hub, cloud API + l

---



 ↑        ↑          ↑        ↑
Pick     Kitchen    Kitchen  Counter (local sale → sync)
app      POS tab    POS tab  desktop POS
```

| Status | Who | How |
|--------|-----|-----|
| **SENT** | Waiter (Flutter **Order Picker**) | `POST /api/pos/restaurant/orders` — goes to kitchen immediately |
| **PREPARING** | Kitchen (desktop POS **Kitchen** tab) | API |
| **READY** | Kitchen | API → counter queue |
| **PAID** | Cashier (desktop POS **Counter** tab) | Payment **local** (`completeSale` queue) → **Sync sales** → cloud |

---

## Where each piece runs

| Surface | App | Network |
|---------|-----|---------|
| Order picking | **Flutter** `bisonstechs_order_picker` | Cloud API only |
| Kitchen queue | **Desktop POS** → Restaurant → Kitchen tab | Cloud API poll |
| Cashier / receipt | **Desktop POS** → Restaurant → Counter tab | Local sale + cloud sync |
| Retail checkout | **Desktop POS** → `sell.js` | Unchanged |

**No WiFi / LAN server.** Devices never talk to each other directly.

---

## Company flag

```prisma
Company.posMode  // retail | restaurant
```

- Set at **web registration** (Retail vs Restaurant)
- Returned on login / `/me` as `user.posMode` and `user.company.posMode`
- Desktop routes: `retail` → `sell.js`, `restaurant` → `restaurant-pos.html`

---

## User roles (web → Users)

| Role | Use |
|------|-----|
| `waiter` | Order Picker mobile app |
| `kitchen` | Desktop POS kitchen tab (default tab on login) |
| `cashier` | Desktop POS counter tab |
| `admin` / `manager` | All + management |

---

## API (`/api/pos/restaurant/`)

- `POST /orders` — create (status **SENT**)
- `GET /orders/kitchen` — SENT + PREPARING
- `GET /orders/ready` — READY for counter
- `POST /orders/:id/preparing` | `/ready` | `/paid`

---

## Flutter Order Picker setup

1. Open `/Users/glplanet/Documents/bisonstechs_order_picker`
2. `flutter pub get`
3. Run with API URL:  
   `flutter run --dart-define=API_URL=https://your-api.com`
4. Login with **waiter** user (restaurant company only)
5. Table + products → **Send to kitchen**

---

## Desktop restaurant POS

After shift open → auto-opens **restaurant-pos.html** (not `sell.js`) when `posMode=restaurant`.

- **Kitchen** tab: Start → Mark ready  
- **Counter** tab: Take payment → saved locally → **Sync sales**

---

## Pricing / signup copy

- Registration step: **Retail vs Restaurant**
- Plans page: restaurant add-on explains Order Picker app + desktop kitchen/counter

---

## Database migration required

```bash
cd account_backend
unset DATABASE_URL && npx prisma migrate deploy
npx prisma generate
```

Migration: `20260831160000_restaurant_pos_mode`

---

## Files touched (reference)

| Area | Path |
|------|------|
| Schema | `account_backend/prisma/schema.prisma` |
| API | `account_backend/pos/controllers/restaurantOrderController.js` |
| Desktop UI | `accounting-desktop-app/src/renderer/restaurant-pos.html/js` |
| Flutter | `bisonstechs_order_picker/lib/` |
| Web signup | `accounting-web-app/app/register/page.tsx` |
| Web users | `accounting-web-app/app/users/UserFormModal.tsx` |

**Not modified:** retail path inside `sell.js`.
