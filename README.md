# MetaDeltaBot

Discord bot สำหรับโพสต์คำแนะนำคราฟต์ Delta Force อัตโนมัติไปยังห้องที่ผู้ดูแลเลือก

## ตั้งค่า

1. ติดตั้ง Node.js 20 หรือใหม่กว่า แล้วรัน `npm install`
2. คัดลอก `.env.example` เป็น `.env`
3. ใส่ `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID` และ (หากผู้ให้บริการออกให้) `DELTAFORCE_API_TOKEN`
4. ใส่ไอเทมที่จะติดตามใน `MARKET_ITEMS` ด้วยรูปแบบ `UUID|ชื่อไอเทม` คั่นแต่ละชิ้นด้วยจุลภาค ตัวอย่าง: `UUID1|AKM,UUID2|Armor`
5. ลงทะเบียนคำสั่งด้วย `npm run register` แล้วเปิดบอตด้วย `npm start`

เชิญบอตเข้าดิสคอร์ดด้วย scopes `bot` และ `applications.commands` และให้สิทธิ์ View Channel, Send Messages, Embed Links ในห้องปลายทาง

## ใช้ใน Discord

- `/setchannel` — เลือกห้องที่บอตจะโพสต์ราคาทุกวัน (ผู้ดูแลเซิร์ฟเวอร์เท่านั้น)
- `/postnow` — ทดสอบโพสต์ราคาทันที
- `/botstatus` — ดูห้องและเวลาที่ตั้งไว้

เวลามาตรฐานคือ 09:00 ตาม `Asia/Bangkok` ปรับได้ที่ `POST_TIME` และ `TIME_ZONE` ใน `.env`

## ทดสอบก่อนเชื่อม API

ตั้ง `DEMO_MODE=true` และรันบอตตามปกติ จากนั้นใช้ `/setchannel` และ `/postnow` ใน Discord บอตจะโพสต์คำแนะนำตัวอย่างแบบ Black Site Workshop โดยไม่เรียก API ภายนอก แต่ละแผนกจะแสดงราคาขาย ต้นทุนวัตถุดิบ กำไรต่อรอบ และกำไรต่อชั่วโมง

กำไรที่บอตใช้คำนวณคือ `ราคาขายของที่คราฟได้ − ราคาวัตถุดิบทั้งหมดจากตลาด` และ `กำไรต่อชั่วโมง = กำไรต่อรอบ ÷ นาทีที่ใช้คราฟ × 60`

> บอตเรียก `POST /deltaforceapi.gateway.ApiService/GetItemAuctionPrice` ของ DeltaForceAPI สำหรับไอเทมแต่ละชิ้น และส่ง `Connect-Protocol-Version: 1` ตามเอกสาร API

## หา UUID ของไอเทม

ใช้คำสั่งนี้เพื่อค้นหาชื่อไอเทมภาษาอังกฤษจาก 100 รายการแรกที่ API ตอบกลับ แล้วคัดลอกบรรทัดผลลัพธ์ไปใส่ใน `MARKET_ITEMS`:

```powershell
npm run find-items -- AKM
```
