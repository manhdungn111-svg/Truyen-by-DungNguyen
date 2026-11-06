# Quýt Truyện + MangaDex

1. Cài Node 18 trở lên.
2. Trong thư mục này chạy: `node server.js`
3. Mở http://localhost:3000

Không cần `npm install`. Đổi cổng bằng `PORT=8080 node server.js`.

Máy chủ chỉ chuyển tiếp yêu cầu GET từ trang tới api.mangadex.org (trình duyệt không gọi trực tiếp được vì MangaDex không bật CORS cho trang lạ). Ảnh bìa và ảnh chương tải thẳng từ MangaDex về trình duyệt.

Dữ liệu và ảnh thuộc MangaDex và nhóm dịch. Trang giữ dòng ghi nguồn MangaDex ở chân trang; nếu đưa lên mạng công khai, hãy đọc điều khoản API của MangaDex (https://api.mangadex.org/docs/).
