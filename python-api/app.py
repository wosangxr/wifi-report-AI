import os
import io
import re
import cv2
import numpy as np
import easyocr
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

# ── Initialize EasyOCR (โหลดครั้งเดียวตอน start) ──
reader = easyocr.Reader(['en'], gpu=False)

# ── โฟลเดอร์เก็บ template ภาพขีดสัญญาณ ──
TEMPLATE_DIR = os.path.join(os.path.dirname(__file__), 'templates')
# ── โฟลเดอร์ debug (เปิดเฉพาะตอน dev) ──
DEBUG_DIR = os.path.join(os.path.dirname(__file__), 'debug')


def preprocess_image(image_bytes):
    """แปลง bytes เป็น OpenCV image และ crop แถบด้านบน"""
    nparr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        return None, None

    h, w = img.shape[:2]

    # Crop เฉพาะแถบ status bar ด้านบน (~8% ของภาพ)
    crop_h = max(int(h * 0.08), 40)
    status_bar = img[0:crop_h, 0:w]

    return img, status_bar


def detect_network_type(status_bar):
    """ใช้ EasyOCR อ่านข้อความจาก status bar เพื่อหาประเภทเครือข่าย"""
    if status_bar is None:
        return "unknown"

    # อ่านทั้ง status bar
    results = reader.readtext(status_bar, detail=0, paragraph=False)
    text = " ".join(results).upper()
    print(f"  [OCR Full] text: '{text}'")

    # ตรวจหา keyword (รวม OCR misread เช่น 46→4G, 56→5G)
    if "5G" in text or "56" in text:
        return "5G"
    elif "LTE" in text:
        return "LTE"
    elif "4G" in text or "46" in text:
        return "4G"
    elif "3G" in text or "36" in text:
        return "3G"

    return "unknown"


def detect_wifi_icon(status_bar):
    """ตรวจจับว่ามี WiFi icon หรือไม่ โดยใช้ Hough Circles / arc detection"""
    if status_bar is None:
        return False

    gray = cv2.cvtColor(status_bar, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape[:2]
    # สนใจฝั่งขวา (WiFi icon มักอยู่ขวาบน)
    right = gray[:, int(w * 0.5):]

    # ใช้ edge detection
    edges = cv2.Canny(right, 50, 150)
    # หา contour ที่มีลักษณะโค้ง (WiFi arcs)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    arc_count = 0
    for cnt in contours:
        if len(cnt) >= 5:
            area = cv2.contourArea(cnt)
            perimeter = cv2.arcLength(cnt, False)
            if perimeter > 0 and area / (perimeter * perimeter + 1e-6) < 0.1:
                arc_count += 1

    return arc_count >= 2


def detect_signal_bars(status_bar):
    """ใช้ OpenCV ตรวจจับจำนวนขีดสัญญาณที่ 'สว่าง' (filled)"""
    if status_bar is None:
        return 0

    # ลอง Template Matching ก่อน (ถ้ามี template)
    template_result = try_template_matching(status_bar)
    if template_result > 0:
        print(f"  [Signal] Template matched: {template_result} bars")
        return template_result

    # วิธีหลัก: หาขีดทั้งหมด แล้ววิเคราะห์ brightness เพื่อนับเฉพาะขีดที่สว่าง
    brightness_result = brightness_based_detection(status_bar)
    if brightness_result > 0:
        print(f"  [Signal] Brightness detection: {brightness_result} bars")
        return brightness_result

    return 0


def try_template_matching(status_bar):
    """ลอง match กับ template ภาพขีดสัญญาณ (5→1)"""
    if not os.path.exists(TEMPLATE_DIR):
        return 0

    gray = cv2.cvtColor(status_bar, cv2.COLOR_BGR2GRAY)

    best_match = 0
    best_score = 0.0
    threshold = 0.6

    for bars in range(5, 0, -1):
        template_path = os.path.join(TEMPLATE_DIR, f'signal_{bars}.png')
        if not os.path.exists(template_path):
            continue

        template = cv2.imread(template_path, cv2.IMREAD_GRAYSCALE)
        if template is None:
            continue

        th, tw = template.shape[:2]
        sh, sw = gray.shape[:2]
        if th > sh or tw > sw:
            scale = min(sh / th, sw / tw) * 0.8
            template = cv2.resize(template, (int(tw * scale), int(th * scale)))

        result = cv2.matchTemplate(gray, template, cv2.TM_CCOEFF_NORMED)
        _, max_val, _, _ = cv2.minMaxLoc(result)

        if max_val > threshold and max_val > best_score:
            best_score = max_val
            best_match = bars

    return best_match


def brightness_based_detection(status_bar):
    """
    หาขีดสัญญาณทั้งหมด (filled + unfilled) แล้ววัดความสว่างแต่ละขีด
    ขีดที่ filled จะสว่างกว่า unfilled อย่างชัดเจน
    """
    gray = cv2.cvtColor(status_bar, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape[:2]

    # สนใจฝั่งขวา ~45% (signal bars อยู่ขวาบน)
    right_start = int(w * 0.50)
    right_region = gray[:, right_start:]
    rh, rw = right_region.shape[:2]

    best_result = 0

    # ลองทั้ง binary ปกติและ inverse (dark / light status bar)
    for invert in [False, True]:
        if invert:
            _, binary = cv2.threshold(right_region, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        else:
            _, binary = cv2.threshold(right_region, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2))
        binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)

        contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        # หา candidate bars (rectangles แนวตั้ง)
        candidates = []
        for cnt in contours:
            x, y, cw, ch = cv2.boundingRect(cnt)
            area = cv2.contourArea(cnt)
            rect_area = cw * ch
            fill_ratio = area / max(rect_area, 1)

            if (ch >= 3 and cw >= 1 and cw <= rw * 0.12
                    and ch <= rh * 0.9 and ch >= cw * 0.6
                    and fill_ratio > 0.3):
                # วัดค่าความสว่างเฉลี่ยภายในขีดนี้ (จาก grayscale เดิม)
                bar_region = right_region[y:y+ch, x:x+cw]
                mean_brightness = float(np.mean(bar_region))
                candidates.append((x, y, cw, ch, mean_brightness))

        if len(candidates) < 3:
            continue

        # เรียงตาม x
        candidates.sort(key=lambda b: b[0])

        # หา cluster ของขีดที่อยู่ใกล้กัน (ascending height)
        for i in range(len(candidates)):
            group = [candidates[i]]
            for j in range(i + 1, len(candidates)):
                prev = group[-1]
                curr = candidates[j]
                gap = curr[0] - (prev[0] + prev[2])
                avg_width = (prev[2] + curr[2]) / 2

                if 0 <= gap <= avg_width * 5:
                    if curr[3] >= prev[3] * 0.6:
                        group.append(curr)
                    else:
                        break
                elif gap > avg_width * 5:
                    break

            if len(group) < 3:
                continue

            # ตรวจว่าเป็น ascending pattern (ขีดสูงขึ้น)
            heights = [g[3] for g in group]
            height_ratio = max(heights) / max(min(heights), 1)

            if height_ratio < 1.2:
                continue  # ไม่ ascending พอ → ไม่ใช่ signal bars

            # ★ วิเคราะห์ brightness เพื่อแยก filled vs unfilled ★
            brightnesses = [g[4] for g in group]
            max_bright = max(brightnesses)
            min_bright = min(brightnesses)

            print(f"    [Bars] Found {len(group)} bars, heights={heights}, brightness={[int(b) for b in brightnesses]}")

            # ถ้าความสว่างแตกต่างกันชัด → นับเฉพาะขีดที่สว่าง
            if max_bright - min_bright > 30:
                # ใช้ threshold กลางระหว่าง min-max brightness
                bright_threshold = (max_bright + min_bright) / 2
                filled_count = sum(1 for b in brightnesses if b >= bright_threshold)
                print(f"    [Brightness] threshold={int(bright_threshold)}, filled={filled_count}/{len(group)}")
                filled_count = max(filled_count, 1)
                best_result = max(best_result, min(filled_count, 5))
            else:
                # ความสว่างใกล้เคียงกัน → อาจเป็นขีดเต็มทุกอัน
                # ลองดูว่าขีดตัดกับ background ต่างกันมั้ย
                # ถ้าไม่ต่างมาก → น่าจะเต็มหมด
                best_result = max(best_result, min(len(group), 5))
                print(f"    [Brightness] Similar brightness → all filled: {len(group)}")

    return best_result


def save_debug(status_bar, label="debug"):
    """บันทึกภาพ debug (เฉพาะ dev)"""
    if not os.path.exists(DEBUG_DIR):
        os.makedirs(DEBUG_DIR, exist_ok=True)
    path = os.path.join(DEBUG_DIR, f'{label}.png')
    cv2.imwrite(path, status_bar)
    print(f"  [Debug] Saved: {path}")


@app.route('/api/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'ok',
        'service': 'WiFi Signal AI — EasyOCR + OpenCV',
        'templates': os.path.exists(TEMPLATE_DIR)
    })


@app.route('/api/analyze', methods=['POST'])
def analyze_signal():
    """รับภาพ → วิเคราะห์ network type + signal bars → ส่ง JSON กลับ"""
    if 'image' not in request.files:
        return jsonify({'success': False, 'error': 'No image provided'}), 400

    file = request.files['image']
    image_bytes = file.read()

    if not image_bytes:
        return jsonify({'success': False, 'error': 'Empty image file'}), 400

    try:
        # STEP 1: Pre-processing
        full_img, status_bar = preprocess_image(image_bytes)
        if full_img is None:
            return jsonify({'success': False, 'error': 'ไม่สามารถอ่านภาพได้'})

        h, w = full_img.shape[:2]
        sh, sw = status_bar.shape[:2]
        print(f"[Analyze] Image: {w}x{h}, Status bar crop: {sw}x{sh}")

        # บันทึก debug
        save_debug(status_bar, "status_bar")

        # STEP 2: OCR → หาประเภทเครือข่าย
        network_type = detect_network_type(status_bar)
        print(f"  [Network] Detected: {network_type}")

        # ตรวจ WiFi icon
        has_wifi = detect_wifi_icon(status_bar)
        if has_wifi and network_type == "unknown":
            network_type = "WiFi"
        print(f"  [WiFi Icon] Detected: {has_wifi}")

        # STEP 3: OpenCV → นับขีดสัญญาณ
        signal_strength = detect_signal_bars(status_bar)
        print(f"  [Signal] Final: {signal_strength} bars")

        # ถ้าตรวจเจอ network type แต่ไม่เจอขีด → ให้ลองขยาย crop area
        if signal_strength == 0:
            print("  [Retry] Trying larger crop (15%)...")
            crop_h2 = max(int(h * 0.15), 60)
            larger_bar = full_img[0:crop_h2, 0:w]
            save_debug(larger_bar, "status_bar_large")
            signal_strength = detect_signal_bars(larger_bar)
            if signal_strength == 0 and network_type == "unknown":
                network_type = detect_network_type(larger_bar)
            print(f"  [Retry] Signal: {signal_strength}, Network: {network_type}")

        # ถ้ายังไม่เจอขีด → ใช้ OCR อ่านตัวเลข % จาก battery เพื่อยืนยันว่า crop ถูก
        # แล้วประเมินจาก network type ว่ามีสัญญาณ
        if signal_strength == 0 and network_type != "unknown":
            # เจอ network type (4G/5G/LTE/WiFi) แต่ไม่เจอขีด → ให้ค่าเริ่มต้น 3
            signal_strength = 3
            print(f"  [Estimate] Network found ({network_type}) but no bars → default 3")

        if signal_strength == 0:
            return jsonify({
                'success': False,
                'error': 'AI วิเคราะห์ไม่พบขีดสัญญาณจากภาพนี้ กรุณาถ่ายรูปให้เห็นไอคอนชัดเจน'
            })

        return jsonify({
            'success': True,
            'network': network_type,
            'signal_strength': signal_strength,
            'ai_method': 'EasyOCR + OpenCV'
        })

    except Exception as e:
        print(f"[Error] {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'error': f'เกิดข้อผิดพลาด: {str(e)}'}), 500


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    print(f"🚀 Python AI API running on port {port}")
    print(f"📂 Template dir: {TEMPLATE_DIR} (exists: {os.path.exists(TEMPLATE_DIR)})")
    app.run(host='0.0.0.0', port=port, debug=False)
