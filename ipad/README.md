# PhotoBoothPad

แอป iPad Native สำหรับย้ายการควบคุม Canon EOS R มาอยู่ที่ iPad และส่ง JPEG กลับเข้า pipeline เดิมเพื่อจัดการ์ด อัปโหลด Nextcloud และเข้าคิวปริ้น

## สถานะ

- หน้าจอ iPad แบบบริการตัวเองครบ flow: เริ่ม → นับถอยหลัง → ตรวจรูป → ถ่ายซ้ำรายช่อง → ประมวลผล → QR
- มี mock camera สำหรับทดสอบแอปและ API โดยยังไม่ต้องเสียบกล้อง
- backend รองรับ `CAPTURE_SOURCE=ipad` และรับ JPEG ผ่าน API ที่มี Bearer token
- จุดเชื่อม EOS R USB แยกไว้ใน `EOSRUSBCameraBackend`
- ยังต้องได้รับ CascableCore SDK + license จึงจะเปิดกล้อง EOS R ผ่าน USB ในแอปจริงได้

## สร้างโปรเจกต์บน Mac

1. ติดตั้ง Xcode 15 หรือใหม่กว่าและ XcodeGen
2. ที่โฟลเดอร์ `ipad` รัน `xcodegen generate`
3. เปิด `PhotoBoothPad.xcodeproj`
4. เลือก Signing Team และรันบน iPad จริง (USB camera ใช้ใน Simulator ไม่ได้)

## ตั้งค่า backend สำหรับทดสอบ

ใน `.env` ของเครื่อง backend:

```env
HOST=0.0.0.0
CAPTURE_SOURCE=ipad
KIOSK_MODE=self_service
IPAD_API_TOKEN=ใส่ข้อความสุ่มอย่างน้อย32ตัว
```

เปิดแอปบน iPad แล้วใส่ URL แบบ HTTPS และ token ค่าเดียวกัน สำหรับการทดสอบ mock บน LAN สามารถใช้ URL ของเครื่อง backend ได้เมื่อผ่านข้อกำหนด App Transport Security แล้ว

## ก่อนใช้งานจริง

1. ขอ evaluation/production license จาก CascableCore
2. เพิ่ม package/framework แล้วเขียน adapter ใน `EOSRUSBCameraBackend`
3. ทดสอบ EOS R + powered USB-C hub + การชาร์จ iPad ต่อเนื่อง
4. ใช้ backend HTTPS เท่านั้นก่อนเปิดระบบชำระเงินจริง
