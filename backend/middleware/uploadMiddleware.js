import multer from "multer";
import path from "path";    
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, "uploads/");
    },
    filename: function (req, file, cb) {
        const ext=file.extname(file.originalname);
        const sessionId=req.param.id|| 'unknown';
        cb(null, Date.now() + file.originalname);
    },
});

const fileFilter=(req, file, cb) => {
    if (file.mimetype === "audio/" || file.mimetype === "application/octet-stream") {
        cb(null, true);
    } else {
        cb(null, false);
    }
}

const upload = multer({ storage: storage, fileFilter: fileFilter , limits: { fileSize: 1024 * 1024 * 10 } });
const uploadSingleAudio = upload.single("audio");
export { uploadSingleAudio };