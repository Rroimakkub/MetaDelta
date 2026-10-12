# MetaDeltaBot

Discord bot สำหรับโพสต์คำแนะนำคราฟต์ Delta Force อัตโนมัติไปยังห้องที่ผู้ดูแลเลือก

## ตั้งค่า

1. ติดตั้ง Node.js 20 หรือใหม่กว่า แล้วรัน `npm install`
2. คัดลอก `.env.example` เป็น `.env`
3. ใส่ `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID` และ (หากผู้ให้บริการออกให้) `DELTAFORCE_API_TOKEN`
4. ใส่สูตรคราฟใน `data/recipes.json` (ดูหัวข้อ "คำแนะนำคราฟจากราคาจริง")
5. ลงทะเบียนคำสั่งด้วย `npm run register` แล้วเปิดบอตด้วย `npm start`

เชิญบอตเข้าดิสคอร์ดด้วย scopes `bot` และ `applications.commands` และให้สิทธิ์ View Channel, Send Messages, Embed Links ในห้องปลายทาง

## ใช้ใน Discord

- `/setchannel` — เลือกห้องที่บอตจะโพสต์ราคาทุกวัน (ผู้ดูแลเซิร์ฟเวอร์เท่านั้น)
- `/postnow` — ทดสอบโพสต์ราคาทันที
- `/botstatus` — ดูห้องและเวลาที่ตั้งไว้

เวลามาตรฐานคือ 09:00 ตาม `Asia/Bangkok` ปรับได้ที่ `POST_TIME` และ `TIME_ZONE` ใน `.env`

## ทดสอบก่อนเชื่อม API

ตั้ง `DEMO_MODE=true` และรันบอตตามปกติ จากนั้นใช้ `/setchannel` และ `/postnow` ใน Discord บอตจะโพสต์คำแนะนำตัวอย่างแบบ Black Site Workshop โดยไม่เรียก API ภายนอก แต่ละแผนกจะแสดงราคาขาย ต้นทุนวัตถุดิบ กำไรต่อรอบ และกำไรต่อชั่วโมง

กำไรที่บอตใช้คำนวณคือ `ราคาขายของที่คราฟได้ × (1 − ภาษี) − ราคาวัตถุดิบทั้งหมดจากตลาด` และ `กำไรต่อชั่วโมง = กำไรต่อรอบ ÷ นาทีที่ใช้คราฟ × 60` ภาษีตั้งได้ที่ `SELL_TAX_PERCENT` (ค่าเริ่มต้น 13)

## คำแนะนำคราฟจากราคาจริง

DeltaForceAPI ไม่มีข้อมูลสูตรคราฟ สูตรจึงอยู่ใน `data/recipes.json` ชุดปัจจุบันแปลงมาจากชีต "DF - Black Site Crafting Costs S11" (กระสุน 40 สูตรของ Workbench และ 34 สูตรของ Armor Bench) รูปแบบไฟล์ดูได้ที่ `data/recipes.example.json`:

- `workshop` — ชื่อแผนก บอตจะโพสต์สูตรที่กำไรต่อชั่วโมงสูงสุดของแต่ละแผนก พร้อมรูปไอเทม (ไม่แสดงสูตรที่ขาดทุน) ค่าเริ่มต้นแผนกละ 1 อันดับ ปรับได้ที่ `TOP_PER_WORKSHOP` (1–10) ใน `.env`
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
