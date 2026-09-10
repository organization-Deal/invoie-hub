# DEAL Invoice Hub V1

ระบบรวมใบแจ้งหนี้/ใบเสร็จจาก Gmail หลายบัญชี → Google Drive กลาง → Dashboard เดียว

## V1 ทำอะไรได้แล้ว
- เชื่อม Gmail ได้หลายบัญชีผ่าน Google OAuth 2.0
- แยกบัญชี Gmail ต้นทางออกจาก Google Drive กลาง
- Sync เองจากหน้า Dashboard หรืออัตโนมัติทุก 30 นาที
- รอบแรกเลือกช่วงย้อนหลังได้ผ่าน API (สูงสุด 1,460 วัน / ~4 ปี)
- รอบถัดไปใช้ `last_sync_at` และ overlap 1 วัน เพื่อกันเมลตกหล่น
- ค้นเมล candidate ด้วย Gmail Search Query
- ดึง Attachment ผ่าน Gmail API
- รองรับ PDF และไฟล์ที่ subject/filename คล้าย invoice/receipt
- กันข้อมูลซ้ำ 2 ชั้น: Gmail IDs + SHA-256 ของไฟล์จริง
- อัปโหลดเข้า Drive กลางอัตโนมัติ แยก `ปี / YYYY-MM / Vendor`
- Dashboard ค้นหา ดู Gmail ต้นทาง เปิดไฟล์จาก Drive และตรวจสถานะเอกสาร
- แก้ Vendor / Invoice No. / วันที่ / Amount / VAT / Currency ได้
- เก็บ refresh token แบบ AES-GCM ใน D1

## สิ่งที่ V1 ยังไม่ได้ทำ
- OCR/AI อ่านตัวเลขใน PDF อัตโนมัติ (เตรียม field ไว้แล้ว)
- ใบเสร็จที่อยู่เฉพาะใน HTML body แต่ไม่มี attachment
- Gmail Push Notification (V1 ใช้ Cron ทุก 30 นาที ซึ่งง่ายและนิ่งกว่าในการเริ่มต้น)
- Login/Role ของพนักงานหน้า Dashboard

## 1) สร้าง Google Cloud Project
เปิด Google Cloud Console แล้ว:
1. Enable **Gmail API**
2. Enable **Google Drive API**
3. ตั้งค่า Google Auth Platform / OAuth consent
4. สร้าง OAuth Client แบบ **Web application**
5. ใส่ Authorized redirect URIs:
   - `https://YOUR-WORKER.workers.dev/auth/gmail/callback`
   - `https://YOUR-WORKER.workers.dev/auth/drive/callback`

Scopes ที่ระบบใช้:
- Gmail source: `https://www.googleapis.com/auth/gmail.readonly`
- Drive storage: `https://www.googleapis.com/auth/drive.file`

> ถ้าบัญชีทั้งหมดอยู่ใน Google Workspace ของบริษัทเดียวกัน แนะนำ Audience = Internal ระหว่างใช้งานในองค์กร

## 2) สร้าง Cloudflare D1
```bash
npx wrangler d1 create deal-invoice-hub
```
เอา `database_id` ที่ได้ไปแทนใน `wrangler.toml`

จากนั้นสร้างตาราง:
```bash
npx wrangler d1 execute deal-invoice-hub --remote --file=schema.sql
```

## 3) ตั้งค่า Worker
แก้ `wrangler.toml`:
```toml
BASE_URL = "https://YOUR-WORKER.workers.dev"
```

เพิ่ม Secrets:
```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put TOKEN_ENCRYPTION_KEY
```

`TOKEN_ENCRYPTION_KEY` ให้ใช้ random string ยาวอย่างน้อย 32 ตัว และเก็บไว้ถาวร ห้ามเปลี่ยนหลังมี Gmail เชื่อมแล้ว เพราะ refresh token เดิมจะถอดรหัสไม่ได้

## 4) Deploy
```bash
npm install -g wrangler
wrangler deploy
```

## 5) วิธีใช้ครั้งแรก
1. เข้า URL Worker
2. กด **เชื่อม Drive กลาง** ก่อน 1 บัญชี — บัญชีนี้จะเป็นเจ้าของโฟลเดอร์ `DEAL Invoice Hub`
3. กด **+ เชื่อม Gmail** แล้ว login Gmail ที่มี subscription ทีละบัญชี
4. กด Sync
5. เอกสารจะเข้า Drive + Dashboard

## ดึงย้อนหลัง 4 ปีครั้งแรก
หน้า UI ตั้งใจ default 30 วันเพื่อไม่ให้ request ใหญ่เกินไป หากต้องการ backfill 4 ปี ให้เปิด DevTools Console แล้วรันทีละ Gmail ID:
```js
fetch('/api/sync', {
  method:'POST',
  headers:{'content-type':'application/json'},
  body:JSON.stringify({ account_id: 1, days_back: 1460 })
}).then(r=>r.json()).then(console.log)
```

**แนะนำจริง:** backfill 4 ปีควรแบ่ง 3–6 เดือนต่อ batch ในเวอร์ชันต่อไป เพราะ Gmail เก่า 4 ปีที่มีไฟล์จำนวนมากอาจชน Cloudflare Worker execution/request limits ขึ้นอยู่กับ plan และจำนวน attachment

## Gmail Query
ค่า default:
```text
{subject:invoice subject:receipt subject:"tax invoice" subject:"ใบเสร็จ" subject:"ใบกำกับภาษี" filename:pdf}
```

สามารถเปลี่ยนผ่าน `/api/settings` เพื่อเพิ่ม vendor หรือ keyword ของบริษัท เช่น Google, Meta, Canva, Adobe, OpenAI ฯลฯ

## Security ก่อน Production
V1 นี้เป็นระบบภายใน starter ที่ใช้งาน API จริงได้ แต่ก่อนเปิดให้พนักงานหลายคนควรเพิ่ม:
- Cloudflare Access / Zero Trust หน้า Dashboard
- Role Owner / Accounting / Viewer
- CSRF protection สำหรับ write endpoints
- Audit log
- Token rotation / key versioning
- Queue สำหรับ backfill ปริมาณมาก
- Google OAuth app verification หากใช้ External และ scope/user count เข้าเงื่อนไขของ Google
