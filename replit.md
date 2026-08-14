# 💕 هنا ويوسف — موقع الحب

## نظرة عامة
موقع رومانسي مخصص لـ هنا يوسف. يعرض ألبوم صور، عداد أيام الحب، أغاني مصرية، وباركود للموقع.

## Stack
- **Backend**: Node.js + Express
- **Frontend**: HTML/CSS/JS (vanilla)
- **Storage**: Local filesystem (`uploads/`) + JSON metadata (`data/photos.json`)
- **Session**: express-session

## تشغيل المشروع
```bash
node server.js
```
يشتغل على port 5000.

## Required Secrets (Replit Secrets — never commit values)
| Secret | Description |
|--------|-------------|
| `SESSION_SECRET` | Express session signing key |
| `LOVE_PASSWORD` | Login password for the site |

Both secrets must be set; the server exits immediately if either is missing.

## الصفحات
| الصفحة | المسار | الوصف |
|--------|--------|--------|
| صفحة الدخول | `/` | إدخال كلمة السر للدخول |
| الألبوم | `/gallery` | معرض الصور + عداد الأيام + موسيقى (يتطلب تسجيل دخول) |
| رفع صور | `/upload` | صفحة رفع الصور والفيديوهات (يتطلب تسجيل دخول) |

## الدخول السري لصفحة الرفع
- اكتبي "بحبك" على الكيبورد في أي مكان وانتِ مسجلة دخول
- أو اذهبي مباشرة لـ `/upload` وانتِ مسجلة دخول

## بيانات الموقع
- **تاريخ البداية**: 23 نوفمبر 2025
- **الدومين المقصود**: hana-youssef.website
- **اللوجو**: `public/assets/logo.png`

## User Preferences
- الموقع بالعربي RTL بالكامل
- أغاني مصرية حب في الخلفية (YouTube embed)
- تصميم داكن رومانسي بألوان وردي وذهبي
