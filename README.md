# MetaDeltaBot

Discord bot สำหรับโพสต์คำแนะนำคราฟต์ Delta Force อัตโนมัติไปยังห้องที่ผู้ดูแลเลือก

## ตั้งค่า

1. ติดตั้ง Node.js 20 หรือใหม่กว่า แล้วรัน `npm install`
2. คัดลอก `.env.example` เป็น `.env`
3. ใส่ `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID` และ (หากผู้ให้บริการออกให้) `DELTAFORCE_API_TOKEN`
4. ใส่สูตรคราฟใน `data/recipes.json` (ดูหัวข้อ "คำแนะนำคราฟจากราคาจริง")
5. เปิดบอตด้วย `npm start` (หรือ `npm run bot:start` เพื่อรันเบื้องหลังด้วย pm2 ดูหัวข้อ "รันบอตตลอดเวลา")

บอตลงทะเบียนคำสั่งในทุกเซิร์ฟเวอร์ที่อยู่เองตอนเปิด และตอนถูกเชิญเข้าเซิร์ฟเวอร์ใหม่ (`npm run register` ใช้เฉพาะตอนบอตปิดอยู่)

เชิญบอตเข้าดิสคอร์ดด้วย scopes `bot` และ `applications.commands` และให้สิทธิ์ View Channel, Send Messages, Embed Links, Attach Files ในห้องปลายทาง:

```
https://discord.com/oauth2/authorize?client_id=<DISCORD_CLIENT_ID>&scope=bot%20applications.commands&permissions=52224
```

## สิทธิ์การใช้คำสั่ง

| คำสั่ง | ใครใช้ได้ |
|---|---|
| `/setchannel`, `/craftpost` | แอดมิน (Manage Server) |
| `/player`, `/craft`, `/price`, `/botstatus` | ทุกคน (`/player`, `/craft` และ `/price` มี cooldown `COMMAND_COOLDOWN_SECONDS` ต่อคน ค่าเริ่มต้น 15 วินาที แอดมินไม่ติด) |

แอดมินจำกัดคำสั่งให้เฉพาะ role หรือห้องเพิ่มเติมได้ที่ Server Settings → Integrations → บอต

## รันบอตตลอดเวลา

โพสต์รายวันทำงานเฉพาะตอนที่บอตเปิดอยู่ ใช้ [pm2](https://pm2.keymetrics.io/) ให้บอตรันเบื้องหลังโดยไม่ต้องเปิด VS Code และเปิดใหม่เองถ้าพัง:

```powershell
npm install -g pm2
npm run bot:start     # เริ่มบอตใน pm2 และบันทึกรายการไว้
npm run bot:logs      # ดู log ล่าสุด
npm run bot:restart   # รีสตาร์ทหลังแก้โค้ดหรือ .env
npm run bot:stop      # หยุดบอต
```

อย่ารัน `npm start` พร้อมกับ pm2 ไม่งั้นจะมีบอต 2 ตัวตอบคำสั่งซ้ำ

Windows ไม่รองรับ `pm2 startup` ให้บอตเปิดเองหลังรีสตาร์ทเครื่องด้วยไฟล์ `metadelta-bot-pm2.vbs` ในโฟลเดอร์ Startup (`shell:startup`) ที่รัน `pm2 resurrect` ตอนล็อกอิน ลบไฟล์นั้นถ้าไม่ต้องการให้เปิดเอง ถ้าปิดเครื่องหรือเครื่องหลับ บอตจะหยุดทำงานจนกว่าจะเปิดเครื่องอีกครั้ง

## รันบน VPS (Linux)

ให้บอตทำงานตลอด 24 ชม. โดยไม่ต้องเปิดคอม: เช่า VPS Ubuntu 24.04 (1 vCPU, RAM 1 GB พอ) แล้วทำตามนี้บนเครื่อง VPS ในฐานะ user ที่ไม่ใช่ root

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git fonts-noto-core fonts-thai-tlwg   # ฟอนต์ Noto ทำให้ภาษาไทยในรูปการ์ดไม่เป็นสี่เหลี่ยม
sudo npm install -g pm2
git clone git@github.com:Rroimakkub/MetaDelta.git   # repo เป็น private: เพิ่ม deploy key ของ VPS ใน GitHub ก่อน
cd MetaDelta && npm ci --omit=dev
```

คัดลอก `.env` และ `data/channels.json` จากเครื่องเดิมด้วย `scp` (ห้าม commit ไฟล์ `.env`) ปิดบอตบนเครื่องเดิมก่อน แล้วเปิดบน VPS:

```bash
pm2 start ecosystem.config.cjs && pm2 save
pm2 startup   # รันคำสั่ง sudo ที่พิมพ์ออกมา บอตจะเปิดเองเมื่อ VPS รีสตาร์ท
```

อัปเดตโค้ดภายหลังด้วย `git pull && npm ci --omit=dev && pm2 restart metadelta-bot` บอตไม่ต้องเปิดพอร์ตใด ๆ เวลาโพสต์ยังเป็นตาม `TIME_ZONE` ไม่ขึ้นกับเวลาของเครื่อง

## ใช้ใน Discord

- `/setchannel` — เลือกห้องที่บอตจะโพสต์ราคาทุกวัน (ผู้ดูแลเซิร์ฟเวอร์เท่านั้น)
- `/setchannel channel:<ห้อง> type:สถิติผู้เล่น` — ตั้งห้องสำหรับผลของ `/player` ถ้าใช้ `/player` ในห้องอื่น บอตจะส่งการ์ดไปที่ห้องนี้และแจ้งคนพิมพ์แบบเห็นคนเดียว
- `/craftpost` — โพสต์คำแนะนำคราฟไปที่ห้องตลาดทันที (เหมือนโพสต์ 09:00)
- โพสต์รายวันมีตาราง **ของแดงราคาสูงสุด Top 10** (ของสะสม T6 ที่ซื้อขายได้) พร้อม 3 ชิ้นที่ราคาขึ้นและลงแรงสุดใน 7 วัน ต่อท้ายคำแนะนำคราฟ
- `/botstatus` — ดูห้องและเวลาที่ตั้งไว้
- `/player name:<ชื่อในเกม หรือ Delta Force ID> season:<ซีซัน>` — ดูสถิติผู้เล่นโหมด Operations แบ่งเป็นข้อมูลเศรษฐกิจ การต่อสู้ และทีม (แบบหน้า My Data ของ playdeltaforce.com) พร้อมมูลค่าคลังและกราฟ 7 วัน เลือกซีซันได้ทุกซีซันหรือ "ตลอดกาล" (ค่าเริ่มต้นคือซีซันปัจจุบัน) ทุกคนในเซิร์ฟเวอร์ใช้ได้ ต้องปิด `DEMO_MODE`
- `/price item:<ไอเทม>` — ดูราคาตลาดตอนนี้ ราคาหลังหักภาษี ค่าเฉลี่ย ต่ำสุด และสูงสุด 7 วัน พร้อมกราฟราคาเฉลี่ยรายชั่วโมง บอกว่าตอนนี้ถูกหรือแพงกว่าค่าเฉลี่ย (พิมพ์ชื่อภาษาอังกฤษแล้วเลือกจากรายการ)
- `/craft item:<ไอเทม>` — ดูสูตร กำไร อันดับในแผนก และการ์ดวัตถุดิบของไอเทมที่คราฟได้ (ราคาเก็บไว้ใช้ซ้ำ 10 นาที ครั้งแรกอาจใช้เวลาประมาณ 20 วินาที)

เวลามาตรฐานคือ 09:00 ตาม `Asia/Bangkok` ปรับได้ที่ `POST_TIME` และ `TIME_ZONE` ใน `.env`

## ทดสอบก่อนเชื่อม API

ตั้ง `DEMO_MODE=true` และรันบอตตามปกติ จากนั้นใช้ `/setchannel` และ `/craftpost` ใน Discord บอตจะโพสต์คำแนะนำตัวอย่างแบบ Black Site Workshop โดยไม่เรียก API ภายนอก แต่ละแผนกจะแสดงราคาขาย ต้นทุนวัตถุดิบ กำไรต่อรอบ และกำไรต่อชั่วโมง

กำไรที่บอตใช้คำนวณคือ `ราคาขายของที่คราฟได้ × (1 − ภาษี) − ราคาวัตถุดิบทั้งหมดจากตลาด` และ `กำไรต่อชั่วโมง = กำไรต่อรอบ ÷ นาทีที่ใช้คราฟ × 60` ภาษีตั้งได้ที่ `SELL_TAX_PERCENT` (ค่าเริ่มต้น 13)

## คำแนะนำคราฟจากราคาจริง

DeltaForceAPI ไม่มีข้อมูลสูตรคราฟ สูตรจึงอยู่ใน `data/recipes.json` ชุดปัจจุบันแปลงมาจากชีต "DF - Black Site Crafting Costs S11" (กระสุน 40 สูตรของ Workbench และ 31 สูตรของ Armor Bench) บวก 9 สูตรของ Pharmacy และ 96 สูตรของ Cyber Warfare Division ที่ใส่เพิ่มเองจากตารางในเกม (ชื่อในตารางบางตัวสั้นกว่าใน API เช่น `AKM` คือ `AKM Assault Rifle` และ Wood Plank คือ `Wood Board`) รูปแบบไฟล์ดูได้ที่ `data/recipes.example.json`:

- `workshop` — ชื่อแผนก บอตจะโพสต์สูตรที่กำไรต่อชั่วโมงสูงสุดของแต่ละแผนก พร้อมรูปไอเทม รายการวัตถุดิบ และราคาวัตถุดิบ (ไม่แสดงสูตรที่ขาดทุน) ค่าเริ่มต้นแผนกละ 1 อันดับ ปรับได้ที่ `TOP_PER_WORKSHOP` (1–10) ใน `.env`

วัตถุดิบแสดงเป็นรูปการ์ดใต้แต่ละไอเทม (รูปวัตถุดิบ ชื่อ จำนวน และราคา) บอตวาดรูปเองด้วย `sharp` และแนบไปกับข้อความ
- `item`, `quantity`, `minutes` — ของที่ได้ จำนวนต่อรอบ และเวลาคราฟ
- `quality` — ระดับไอเทม (ไม่บังคับ) ใช้เมื่อชื่อย่อ เช่น `"5.7x28mm"` กับ `5` จะหาไอเทมระดับ 5 ที่ชื่อขึ้นต้นด้วยคำนั้น
- `materials` — วัตถุดิบ `{ "item": "...", "quantity": 2 }` ใส่ `"price"` เองได้สำหรับของที่ไม่มีขายในตลาด
- `intermediates` — วัตถุดิบที่ต้องคราฟเอง (เช่น Premium Fuel) บอตคิดต้นทุนจากวัตถุดิบย่อย ÷ จำนวนที่ได้ต่อรอบ

ตั้ง `DEMO_MODE=false` แล้วตรวจสูตรและราคาก่อนโพสต์ด้วย:

```powershell
npm run check-crafts
```

`MARKET_ITEMS` ไม่จำเป็นแล้ว ถ้าใส่ไว้บอตจะโพสต์ราคาตลาดของไอเทมเหล่านั้นต่อท้ายด้วย

> บอตเรียก `POST /deltaforceapi.gateway.ApiService/GetItemAuctionPrice` ของ DeltaForceAPI สำหรับไอเทมแต่ละชิ้น และส่ง `Connect-Protocol-Version: 1` ตามเอกสาร API

## สร้าง API key

ต้องมีแอป Authenticator ในมือถือ (เช่น Google Authenticator) แล้วรัน:

```powershell
npm run create-key
```

สคริปต์จะสมัครผู้ใช้ให้ แสดงรหัสลับ TOTP ให้ใส่ในแอป Authenticator แล้วใช้รหัส 6 หลักจากแอปสร้าง key แบบ server-to-server และบันทึกลง `.env` เป็น `DELTAFORCE_API_TOKEN` ให้เอง ถ้าเคยสมัครแล้วให้เลือก "มีผู้ใช้แล้ว"

บอตส่ง key ใน header `deltaforceapi-gateway-key` ตามที่ API กำหนด

## หา UUID ของไอเทม

ใช้คำสั่งนี้เพื่อค้นหาชื่อไอเทมภาษาอังกฤษจากไอเทมทั้งหมด ใช้ชื่อที่ได้ใน `data/recipes.json` หรือคัดลอกทั้งบรรทัดไปใส่ใน `MARKET_ITEMS`:

```powershell
npm run find-items -- AKM
```
