document.addEventListener('DOMContentLoaded', () => {
    const supabaseUrl = 'https://fvzcusbcleyytjnyzgib.supabase.co';
    const supabaseKey = 'sb_publishable_ZFBeEQ9zscxS-MNLwhSbZQ_KGgQJMHf';
    const supabaseClient = window.supabase.createClient(supabaseUrl, supabaseKey);

    // --- Theme Logic ---
    const themes = ['light', 'dark', 'pink'];
    let currentThemeIndex = themes.indexOf(localStorage.getItem('wifi_theme') || 'light');
    if (currentThemeIndex === -1) currentThemeIndex = 0;

    function applyTheme() {
        const theme = themes[currentThemeIndex];
        if (theme === 'light') document.body.removeAttribute('data-theme');
        else document.body.setAttribute('data-theme', theme);
        localStorage.setItem('wifi_theme', theme);

        const icon = themeToggleBtn.querySelector('i');
        if (icon) {
            icon.className = theme === 'light' ? 'bx bx-sun' :
                theme === 'dark' ? 'bx bx-moon' : 'bx bx-infinite';
        }
    }

    const themeToggleBtn = document.getElementById('globalThemeToggle');
    applyTheme();
    if (themeToggleBtn) {
        themeToggleBtn.addEventListener('click', () => {
            currentThemeIndex = (currentThemeIndex + 1) % themes.length;
            applyTheme();
        });
    }

    // --- Login Logic ---
    const loginForm = document.getElementById('loginForm');
    const loginContainer = document.getElementById('loginContainer');
    const appContainer = document.getElementById('appContainer');

    if (loginForm) {
        loginForm.addEventListener('submit', (e) => {
            e.preventDefault();

            const usernameVal = document.getElementById('username').value;
            const fullNameVal = document.getElementById('fullName').value;

            if (!usernameVal || !fullNameVal) {
                alert('กรุณากรอกข้อมูลให้ครบถ้วน');
                return;
            }

            localStorage.setItem('wifi_user_id', usernameVal);
            localStorage.setItem('wifi_user_name', fullNameVal);

            const btn = loginForm.querySelector('.login-btn');
            const originalText = btn.innerHTML;
            btn.innerHTML = `<i class='bx bx-loader-alt bx-spin'></i> กำลังเข้าสู่ระบบ...`;
            btn.style.opacity = "0.8";
            btn.disabled = true;

            setTimeout(() => {
                loginContainer.classList.add('fade-out-up');

                setTimeout(() => {
                    loginContainer.style.display = 'none';
                    appContainer.style.display = 'flex';
                    void appContainer.offsetWidth;
                    appContainer.style.animation = 'fadeInUp 0.6s ease-out forwards';
                }, 500);
            }, 800);
        });
    }

    // --- Signal Image Upload Logic ---
    const uploadArea = document.getElementById('uploadArea');
    const signalImage = document.getElementById('signalImage');
    const imagePreview = document.getElementById('imagePreview');
    const previewImg = document.getElementById('previewImg');
    const removeImageBtn = document.getElementById('removeImageBtn');
    const aiStatus = document.getElementById('aiStatus');
    const signalInput = document.getElementById('signalValue');
    const signalText = document.getElementById('signalText');

    let isAIProcessing = false; // สร้างตัวแปรเช็คสถานะ AI ป้องกันการกดส่งก่อนเสร็จ

    const signalTexts = {
        1: "AI ตรวจพบ: 1 ขีด - สัญญาณอ่อนมาก",
        2: "AI ตรวจพบ: 2 ขีด - สัญญาณอ่อน",
        3: "AI ตรวจพบ: 3 ขีด - สัญญาณปานกลาง",
        4: "AI ตรวจพบ: 4 ขีด - สัญญาณดี",
        5: "AI ตรวจพบ: 5 ขีด - สัญญาณเต็มขีด"
    };

    const signalColors = {
        1: "#f72585",
        2: "#f8961e",
        3: "#f9c74f",
        4: "#4cc9f0",
        5: "#4361ee"
    };

    if (uploadArea) {
        uploadArea.addEventListener('click', () => signalImage.click());

        uploadArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadArea.style.borderColor = 'var(--primary)';
            uploadArea.style.background = 'rgba(67, 97, 238, 0.05)';
        });

        uploadArea.addEventListener('dragleave', () => {
            uploadArea.style.borderColor = '';
            uploadArea.style.background = '';
        });

        uploadArea.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadArea.style.borderColor = '';
            uploadArea.style.background = '';
            if (e.dataTransfer.files.length) {
                signalImage.files = e.dataTransfer.files;
                handleImageUpload();
            }
        });
    }

    if (signalImage) {
        signalImage.addEventListener('change', handleImageUpload);
    }

    if (removeImageBtn) {
        removeImageBtn.addEventListener('click', () => {
            signalImage.value = "";
            imagePreview.style.display = 'none';
            uploadArea.style.display = 'flex';
            signalInput.value = "";

            // รีเซ็ตสถานะปุ่มเมื่อยกเลิกรูป
            isAIProcessing = false;
            const submitBtn = document.querySelector('#issueForm button[type="submit"]');
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = `<span>ส่งแจ้งปัญหา</span><i class='bx bx-send'></i>`;
                submitBtn.style.opacity = "1";
            }

            aiStatus.style.display = 'none';
            signalText.style.display = 'block';
            signalText.textContent = "กรุณาอัปโหลดรูปภาพ";
            signalText.style.color = "var(--text-muted)";

            // รีเซ็ต manual picker ด้วย
            document.querySelectorAll('.signal-pick-btn').forEach(b => {
                b.style.border = '2px solid #e2e8f0';
                b.style.background = 'white';
                b.style.transform = '';
            });
            const manualText = document.getElementById('manualSignalText');
            if (manualText) manualText.style.display = 'none';
        });
    }

    // --- Manual Signal Picker Logic ---
    const manualSignalColors = { 1: "#f72585", 2: "#f8961e", 3: "#4cc9f0", 4: "#4361ee" };
    const manualSignalLabels = { 1: "สัญญาณอ่อนมาก", 2: "สัญญาณอ่อน", 3: "สัญญาณปานกลาง", 4: "สัญญาณเต็มขีด" };

    document.querySelectorAll('.signal-pick-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const val = parseInt(btn.dataset.signal);
            signalInput.value = val;

            // รีเซ็ตทุกปุ่ม
            document.querySelectorAll('.signal-pick-btn').forEach(b => {
                b.style.border = '2px solid #e2e8f0';
                b.style.background = 'white';
                b.style.transform = '';
                b.style.boxShadow = '';
            });

            // ไฮไลท์ปุ่มที่เลือก
            const color = manualSignalColors[val];
            btn.style.border = `2px solid ${color}`;
            btn.style.background = `${color}15`;
            btn.style.transform = 'scale(1.08)';
            btn.style.boxShadow = `0 4px 12px ${color}30`;

            // แสดงข้อความ
            const manualText = document.getElementById('manualSignalText');
            if (manualText) {
                manualText.style.display = 'block';
                manualText.textContent = `เลือกแล้ว: ${val} ขีด — ${manualSignalLabels[val]}`;
                manualText.style.color = color;
            }

            // อัปเดต signalText ด้านบนด้วย
            signalText.style.display = 'block';
            signalText.textContent = `กรอกเอง: ${val} ขีด — ${manualSignalLabels[val]}`;
            signalText.style.color = color;
            signalText.style.fontWeight = '600';
        });
    });

    async function handleImageUpload() {
        if (!signalImage.files || !signalImage.files[0]) return;

        // ล็อคปุ่มส่งฟอร์มไว้ก่อนระหว่างรอ AI
        isAIProcessing = true;
        const submitBtn = document.querySelector('#issueForm button[type="submit"]');
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.style.opacity = "0.6";
            submitBtn.innerHTML = `<i class='bx bx-loader-alt bx-spin'></i> รอ AI ประมวลผล...`;
        }

        const file = signalImage.files[0];

        const reader = new FileReader();
        reader.onload = (e) => {
            previewImg.src = e.target.result;
            uploadArea.style.display = 'none';
            imagePreview.style.display = 'block';

            signalText.style.display = 'none';
            aiStatus.style.display = 'flex';
        };
        reader.readAsDataURL(file);

        const formData = new FormData();
        formData.append('image', file);

        try {
            const response = await fetch('/api/analyze-signal', {
                method: 'POST',
                body: formData
            });
            const data = await response.json();

            aiStatus.style.display = 'none';
            signalText.style.display = 'block';

            if (data.success) {
                const signal = parseInt(data.signal_level);
                signalInput.value = signal;

                const networkLabel = data.network && data.network !== 'unknown' ? ` [เครือข่าย: ${data.network}]` : '';
                signalText.textContent = (signalTexts[signal] || `AI ตรวจพบ: ${signal} ขีด`) + networkLabel;
                signalText.style.color = signalColors[signal] || "var(--primary)";
                signalText.style.fontWeight = "600";
            } else {
                throw new Error(data.error || 'การวิเคราะห์ล้มเหลว');
            }
        } catch (error) {
            console.error('AI Image Analysis Error:', error);
            aiStatus.style.display = 'none';
            signalText.style.display = 'block';

            signalInput.value = "";
            signalText.textContent = error.message || `ระบบ AI ไม่พบสัญญาณจากภาพ ลองใหม่อีกครั้ง`;
            signalText.style.color = "#f72585";
            signalText.style.fontWeight = "600";
        } finally {
            // ปลดล็อคปุ่มหลังจาก AI ทำงานเสร็จ (ไม่ว่าจะผ่านหรือไม่ผ่าน)
            isAIProcessing = false;
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.style.opacity = "1";
                submitBtn.innerHTML = `<span>ส่งแจ้งปัญหา</span><i class='bx bx-send'></i>`;
            }
        }
    }

    // --- Dashboard Data ---
    const locationOptions = ["อาคาร1", "อาคาร2", "อาคาร3", "อาคารอเนกประสงค์", "อาคาร4", "อาคาร5", "อาคาร6", "อาคารศูนย์อาหาร1", "อาคารสำนักงานกลาง", "อาคาร9", "อาคาร10", "อาคาร11", "อาคารศูนย์มีเดีย", "อื่นๆ"];
    let topSpots = locationOptions.map((loc, index) => ({ name: loc, count: 0, rank: index + 1 }));

    const spotsList = document.getElementById('topSpotsList');

    function renderSpots() {
        if (!spotsList) return;
        spotsList.innerHTML = '';
        topSpots.forEach((spot, index) => {
            const rankClass = spot.rank <= 5 ? `item-rank-${spot.rank}` : 'item-rank-others';
            const html = `
                <div class="spot-item ${rankClass}" style="animation: fadeIn 0.5s ease-out ${index * 0.1}s backwards;">
                    <div class="spot-rank">${spot.rank}</div>
                    <div class="spot-info">
                        <div class="spot-name">${spot.name}</div>
                        <div class="spot-bar-bg">
                            <div class="spot-bar-fill" ${spot.count === 0 ? 'style="width: 0%;"' : ''}></div>
                        </div>
                    </div>
                    <div class="spot-count">${spot.count} ครั้ง</div>
                </div>
            `;
            spotsList.innerHTML += html;
        });
    }

    async function loadDashboardData() {
        const { data: issues, error } = await supabaseClient
            .from('wifi_reports')
            .select('*');
        if (!error && issues) {
            const resetRows = issues.filter(i => i.location === 'SYSTEM_RESET');
            let resetTime = 0;
            if (resetRows.length > 0) {
                const latestReset = resetRows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
                resetTime = new Date(latestReset.created_at).getTime();
            }

            topSpots.forEach(s => s.count = 0);

            issues.forEach(issue => {
                if (issue.location === 'SYSTEM_RESET') return;
                const issueTime = new Date(issue.created_at).getTime();
                if (issueTime < resetTime) return;

                const loc = issue.location;
                const spot = topSpots.find(s => s.name === loc);
                if (spot) {
                    spot.count++;
                } else if (loc && loc !== "อื่นๆ") {
                    topSpots.push({ name: loc, count: 1, rank: 99 });
                }
            });

            topSpots.sort((a, b) => b.count - a.count);
            topSpots.forEach((s, i) => s.rank = i + 1);
            renderSpots();
        }
    }

    loadDashboardData();

    // --- Form Submission ---
    const form = document.getElementById('issueForm');
    const toast = document.getElementById('toast');

    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();

            // ป้องกันการกดย้ำถ้า AI ยังโหลดไม่เสร็จ
            if (isAIProcessing) {
                alert('กรุณารอระบบ AI ประมวลผลรูปภาพสักครู่ครับ');
                return;
            }

            if (!signalInput.value) {
                signalText.textContent = "กรุณาอัปโหลดภาพ หรือ เลือกระดับสัญญาณด้านล่าง!";
                signalText.style.color = "#f72585";

                uploadArea.style.animation = "shake 0.5s";
                setTimeout(() => uploadArea.style.animation = "", 500);

                // เขย่า manual picker ด้วย
                const picker = document.getElementById('manualSignalPicker');
                if (picker) {
                    picker.style.animation = "shake 0.5s";
                    setTimeout(() => picker.style.animation = "", 500);
                }
                return;
            }

            const btn = form.querySelector('button[type="submit"]');
            const originalText = btn.innerHTML;
            btn.innerHTML = `<i class='bx bx-loader-alt bx-spin'></i> กำลังส่งข้อมูล...`;
            btn.style.opacity = "0.8";
            btn.disabled = true;

            const student_id = localStorage.getItem('wifi_user_id') || 'ไม่ระบุ';
            const fullname = localStorage.getItem('wifi_user_name') || 'ไม่ระบุ';

            const payload = {
                student_id,
                fullname,
                location: document.getElementById('location').value,
                room: document.getElementById('room').value,
                problem: "พบปัญหาจากภาพถ่าย",
                signal: parseInt(signalInput.value),
                details: document.getElementById('details').value || "-"
            };

            try {
                let uploadedImageUrl = null;
                if (signalImage.files && signalImage.files[0]) {
                    const file = signalImage.files[0];
                    const fileExt = file.name.split('.').pop();
                    const fileName = `${Date.now()}_${Math.random().toString(36).substring(7)}.${fileExt}`;
                    const filePath = `uploads/${fileName}`;

                    btn.innerHTML = `<i class='bx bx-loader-alt bx-spin'></i> อัปโหลดรูปภาพ...`;

                    const { data: uploadData, error: uploadError } = await supabaseClient.storage
                        .from('wifi_images')
                        .upload(filePath, file);

                    if (uploadError) {
                        console.error('Upload Error:', uploadError);
                    } else {
                        const { data } = supabaseClient.storage.from('wifi_images').getPublicUrl(filePath);
                        uploadedImageUrl = data.publicUrl;
                    }
                }

                btn.innerHTML = `<i class='bx bx-loader-alt bx-spin'></i> กำลังบันทึกข้อมูล...`;

                const { data: result, error } = await supabaseClient
                    .from('wifi_reports')
                    .insert([
                        {
                            username: `${payload.student_id} - ${payload.fullname}`,
                            location: payload.location,
                            room: payload.room,
                            problem: payload.problem,
                            signal_level: payload.signal,
                            details: payload.details,
                            image_url: uploadedImageUrl
                        }
                    ]);

                if (error) throw error;

                if (toast) toast.classList.add('show');

                const selLoc = payload.location;
                const spotToUpdate = topSpots.find(spot => spot.name === selLoc);
                if (spotToUpdate) {
                    spotToUpdate.count++;
                } else if (selLoc !== "อื่นๆ" && selLoc) {
                    topSpots.push({ name: selLoc, count: 1, rank: 99 });
                }

                topSpots.sort((a, b) => b.count - a.count);
                topSpots.forEach((s, i) => s.rank = i + 1);
                renderSpots();

                form.reset();
                if (removeImageBtn) removeImageBtn.click();

                setTimeout(() => {
                    if (toast) toast.classList.remove('show');
                }, 3500);

            } catch (error) {
                console.error('Error!', error.message);
                alert('เกิดข้อผิดพลาดในการส่งข้อมูล กรุณาลองใหม่อีกครั้ง');
            } finally {
                btn.innerHTML = originalText;
                btn.style.opacity = "1";
                btn.disabled = false;
            }
        });
    }
});

const style = document.createElement('style');
style.innerHTML = `
@keyframes shake {
  0% { transform: translateX(0); }
  25% { transform: translateX(-8px); }
  50% { transform: translateX(8px); }
  75% { transform: translateX(-8px); }
  100% { transform: translateX(0); }
}
`;
document.head.appendChild(style);