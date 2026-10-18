# Photo Booth Design System Specification (DESIGN.md)

มาตรฐานการออกแบบส่วนต่อประสานผู้ใช้ (UI/UX Design Tokens & System) สำหรับระบบ Photo Booth
ครอบคลุมหน้าจอจอลูกค้า (Kiosk / iPad Screen), จอช่างควบคุม (Operator Screen), และหน้าดาวน์โหลดภาพของลูกค้า (Customer Landing Page)

---

## 1. ปรัชญาการออกแบบ (Design Philosophy)
1. **Touch-First & Kiosk Optimized**: ทุกปุ่มและองค์ประกอบที่ต้องสัมผัสต้องมีขนาดไม่น้อยกว่า 44×44px (แนะนำ 48-64px สำหรับจอทัชสกรีน) เพื่อให้ผู้ใช้ทุกวัยกดได้แม่นยำ ไม่พลาด
2. **Deep Obsidian Aesthetics**: พื้นหลังมืดระดับ Deep Obsidian (#0D0D12) ขับเน้นภาพถ่าย Live View และ Photo Strip ให้โดดเด่น สบายตา ไม่สะท้อนแสงรบกวนในสถานที่จัดงาน
3. **Clarity over Complexity**: ไม่ใช้เมนูหรือตัวเลือกซ้อนทับ ผู้ใช้ทั่วไปต้องเห็นชัดเจนว่าสถานะปัจจุบันคืออะไร และขั้นตอนถัดไปต้องทำอะไร
4. **Predictable States & Feedback**: มีการตอบสนองที่ชัดเจนในทุกสถานะ (Hover, Active, Focus, Disabled, Processing, Flash)

---

## 2. โทนสีและโทเค็น (Color Tokens)

| Token | รหัสสี (Hex) | วัตถุประสงค์การใช้งาน |
|---|---|---|
| `--bg` | `#0D0D12` | พื้นหลังหลักหน้าจอ Kiosk และ Operator |
| `--card-bg` | `#17171F` | พื้นหลังการ์ด ส่วนควบคุม และกล่องสถานะ |
| `--border` | `#26262F` / `#3A3A46` | เส้นขอบการ์ดและปุ่มรอง |
| `--fg` | `#F5F5F7` | สีข้อความหลัก คอนทราสต์สูง (> 12:1 บนพื้นหลังมืด) |
| `--muted` | `#9A9AA8` | สีข้อความรอง / คำอธิบายประกอบ (WCAG AA compliant) |
| `--accent` | `#FF4D6D` | สีหลักของแบรนด์ (Vibrant Coral Pink) ใช้กับปุ่ม Call-to-Action เด่น |
| `--accent-2` | `#FFD166` | สีรอง (Warm Gold) ใช้กับจุดนับถอยหลัง, กรอบ Focus, และสถานะไฮไลท์ |
| `--status-ok` | `#77E2A8` / `#10B981` | สถานะกล้องพร้อม, เชื่อมต่อสำเร็จ, ดำเนินการผ่าน |
| `--status-bad` | `#FF4D6D` / `#EF4444` | สถานะกล้องขัดข้อง, ข้อผิดพลาด |
| `--btn-primary` | `#2563EB` | ปุ่มสั่งการถ่ายภาพถัดไปบนหน้าจอช่าง |
| `--btn-success` | `#059669` | ปุ่มยืนยันเสร็จงานบนหน้าจอช่าง |

---

## 3. ตัวอักษรและวรรณยุกต์ (Typography)

- **ชุดฟอนต์หลัก (Font Stack)**: `"Prompt", "Sarabun", "Plus Jakarta Sans", "Segoe UI", system-ui, sans-serif`
- **การจัดลำดับขนาด (Hierarchy)**:
  - **Display Title (ชื่องานบน Kiosk)**: `clamp(40px, 7vw, 96px)`, น้ำหนัก 800 (Bold)
  - **Section Headings (h2)**: `clamp(24px, 3.5vw, 44px)`, น้ำหนัก 700 (SemiBold)
  - **Button Text (Kiosk)**: `clamp(20px, 2.6vw, 34px)`, น้ำหนัก 700
  - **Body / Subtitle Text**: `clamp(18px, 2.2vw, 30px)`, สี `--muted`
  - **Status & Badges**: 14px - 18px, น้ำหนัก 700
  - **Micro Hint & Notes**: 13px - 15px

---

## 4. รูปทรงและระยะห่าง (Shapes, Spacing & Elevation)

- **มุมโค้ง (Border Radius)**:
  - **Buttons (Kiosk)**: `999px` (Pill Shape เต็มรูปแบบ ให้ความรู้สึกเป็นมิตรและกดง่าย)
  - **Buttons (Operator)**: `10px` - `12px` (Squircle กระชับ สไตล์ Dashboard)
  - **Cards & Stage**: `20px` - `28px`
  - **QR Code Box**: `24px`
- **เงาและการยกระดับ (Shadows)**:
  - ปุ่มหลัก Kiosk: `box-shadow: 0 12px 40px rgba(255, 77, 109, 0.35)`
  - การ์ดภาพตัวอย่าง: `box-shadow: 0 14px 40px rgba(0, 0, 0, 0.5)`

---

## 5. สถานะปุ่มและการเข้าถึง (Interaction & Accessibility)

- **Active State**: ยุบตัวลงเล็กน้อยเมื่อแตะ (`transform: scale(0.97)`)
- **Disabled State**:
  - พื้นหลังสีเทาเข้ม `#3A3A46` และตัวหนังสือสี `#B5B5C2` (ให้อ่านได้ชัดเจนแต่รู้ว่ากดไม่ได้)
  - ลดเงาลง `box-shadow: none; cursor: not-allowed;`
- **Focus-Visible State**:
  - ทุกปุ่มและช่องอินพุตต้องมี `:focus-visible` ชัดเจนด้วยสีตัดกัน `outline: 3px solid #FFD166; outline-offset: 3px;`
- **Safe Area Insets**:
  - รองรับ `env(safe-area-inset-top)` และ `env(safe-area-inset-bottom)` เพื่อไม่ให้องค์ประกอบชนติ่งกล้องหรือแถบโฮมของ iPad

---

## 6. โครงสร้างสถานะหน้าจอ (Kiosk Screen State Machine)

```
[screen-setup] (เมื่อยังไม่ได้จับคู่คุกกี้)
      │ (กรอกรหัสจับคู่สำเร็จ)
      ▼
[screen-idle] (หน้าต้อนรับ: แตะตรงไหนของจอเพื่อเริ่มได้)
      │
      ├──> (เปิดให้เลือกแบบ) ──> [screen-layout] (เลือกแบบการ์ด: เลื่อนแนวตั้งได้)
      │                               │
      └──> (แบบเดียว/เลือกแล้ว) ───────┴─> [screen-shoot] (Live View + นับถอยหลัง + ตรวจรูป)
                                                │
                                                ▼ (ครบทุกช็อต/กดยืนยัน)
                                          [screen-processing] (แสดงตัวหมุนประมวลผล)
                                                │
                                                ▼ (รวมภาพ + วิดีโอเสร็จ)
                                          [screen-done] (แสดง QR Code + รูปการ์ด + นับถอยหลัง 90s)
                                                │
                                                ▼ (หมดเวลาหรือกดเสร็จแล้ว)
                                          [screen-idle]
```
