const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 10000;

// 반드시 Render Environment Variable에 설정하세요.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!ADMIN_PASSWORD) {
    console.error("ERROR: ADMIN_PASSWORD 환경변수가 설정되지 않았습니다.");
    process.exit(1);
}

// Render Persistent Disk를 사용할 경우 /var/data를 디스크 경로로 사용
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "applicants.json");

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DEFAULT_APPLICANTS = {
    "yiopcnh": { role: "오프너" },
    "roo_1332": { role: "오프너 (수석)" },
    "han_vvvv": { role: "WSP" }
};

function loadApplicants() {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            fs.writeFileSync(
                DATA_FILE,
                JSON.stringify(DEFAULT_APPLICANTS, null, 2),
                "utf8"
            );
            return { ...DEFAULT_APPLICANTS };
        }

        return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    } catch (error) {
        console.error("합격자 데이터 로딩 오류:", error);
        return { ...DEFAULT_APPLICANTS };
    }
}

function saveApplicants(data) {
    fs.writeFileSync(
        DATA_FILE,
        JSON.stringify(data, null, 2),
        "utf8"
    );
}

let applicants = loadApplicants();

function sendJSON(res, status, data) {
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
    });

    res.end(JSON.stringify(data));
}

function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = "";

        req.on("data", chunk => {
            body += chunk;

            // 지나치게 큰 요청 방지
            if (body.length > 1024 * 1024) {
                req.destroy();
                reject(new Error("Request too large"));
            }
        });

        req.on("end", () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch {
                reject(new Error("Invalid JSON"));
            }
        });

        req.on("error", reject);
    });
}

function createToken() {
    return crypto.randomBytes(32).toString("hex");
}

// 간단한 메모리 세션
// 서버가 재시작되면 관리자 로그인도 다시 필요합니다.
const adminSessions = new Set();

function isAdmin(req) {
    const token = req.headers.authorization;

    if (!token || !token.startsWith("Bearer ")) {
        return false;
    }

    return adminSessions.has(token.slice(7));
}

function cleanText(value, maxLength = 100) {
    if (typeof value !== "string") return "";
    return value.trim().slice(0, maxLength);
}

async function handleAPI(req, res) {
    // 관리자 로그인
    if (req.method === "POST" && req.url === "/api/admin/login") {
        try {
            const body = await parseBody(req);
            const password = String(body.password || "");

            if (!crypto.timingSafeEqual(
                Buffer.from(password),
                Buffer.from(ADMIN_PASSWORD)
            )) {
                return sendJSON(res, 401, {
                    success: false,
                    message: "비밀번호가 올바르지 않습니다."
                });
            }

            const token = createToken();
            adminSessions.add(token);

            return sendJSON(res, 200, {
                success: true,
                token
            });
        } catch {
            return sendJSON(res, 400, {
                success: false,
                message: "잘못된 요청입니다."
            });
        }
    }

    // 관리자 로그아웃
    if (req.method === "POST" && req.url === "/api/admin/logout") {
        if (isAdmin(req)) {
            adminSessions.delete(req.headers.authorization.slice(7));
        }

        return sendJSON(res, 200, { success: true });
    }

    // 관리자 API 보호
    if (req.url.startsWith("/api/admin/") && !isAdmin(req)) {
        return sendJSON(res, 401, {
            success: false,
            message: "관리자 인증이 필요합니다."
        });
    }

    // 합격자 전체 조회
    if (req.method === "GET" && req.url === "/api/admin/applicants") {
        const list = Object.entries(applicants).map(([nickname, data]) => ({
            nickname,
            role: data.role
        }));

        return sendJSON(res, 200, {
            success: true,
            applicants: list
        });
    }

    // 합격자 추가
    if (req.method === "POST" && req.url === "/api/admin/applicants") {
        try {
            const body = await parseBody(req);

            const nickname = cleanText(body.nickname);
            const role = cleanText(body.role);

            if (!nickname || !role) {
                return sendJSON(res, 400, {
                    success: false,
                    message: "닉네임과 포지션을 입력해주세요."
                });
            }

            if (applicants[nickname]) {
                return sendJSON(res, 409, {
                    success: false,
                    message: "이미 등록된 닉네임입니다."
                });
            }

            applicants[nickname] = { role };
            saveApplicants(applicants);

            return sendJSON(res, 201, {
                success: true,
                message: "합격자가 추가되었습니다."
            });
        } catch {
            return sendJSON(res, 400, {
                success: false,
                message: "잘못된 요청입니다."
            });
        }
    }

    // 합격자 수정
    if (
        req.method === "PUT" &&
        req.url.startsWith("/api/admin/applicants/")
    ) {
        try {
            const nickname = decodeURIComponent(
                req.url.replace("/api/admin/applicants/", "")
            );

            const body = await parseBody(req);
            const role = cleanText(body.role);

            if (!applicants[nickname]) {
                return sendJSON(res, 404, {
                    success: false,
                    message: "합격자를 찾을 수 없습니다."
                });
            }

            if (!role) {
                return sendJSON(res, 400, {
                    success: false,
                    message: "포지션을 입력해주세요."
                });
            }

            applicants[nickname].role = role;
            saveApplicants(applicants);

            return sendJSON(res, 200, {
                success: true,
                message: "포지션이 수정되었습니다."
            });
        } catch {
            return sendJSON(res, 400, {
                success: false,
                message: "잘못된 요청입니다."
            });
        }
    }

    // 합격자 삭제
    if (
        req.method === "DELETE" &&
        req.url.startsWith("/api/admin/applicants/")
    ) {
        try {
            const nickname = decodeURIComponent(
                req.url.replace("/api/admin/applicants/", "")
            );

            if (!applicants[nickname]) {
                return sendJSON(res, 404, {
                    success: false,
                    message: "합격자를 찾을 수 없습니다."
                });
            }

            delete applicants[nickname];
            saveApplicants(applicants);

            return sendJSON(res, 200, {
                success: true,
                message: "합격자가 삭제되었습니다."
            });
        } catch {
            return sendJSON(res, 400, {
                success: false,
                message: "삭제 중 오류가 발생했습니다."
            });
        }
    }

    return sendJSON(res, 404, {
        success: false,
        message: "API를 찾을 수 없습니다."
    });
}

function serveStatic(req, res) {
    let requestPath = req.url.split("?")[0];

    if (requestPath === "/") {
        requestPath = "/index.html";
    }

    // 관리자 API
    if (requestPath.startsWith("/api/")) {
        return handleAPI(req, res);
    }

    // 관리자 페이지
    if (requestPath === "/admin") {
        requestPath = "/admin.html";
    }

    const filePath = path.join(__dirname, requestPath);

    // 프로젝트 밖 접근 방지
    if (!filePath.startsWith(__dirname)) {
        res.writeHead(403);
        return res.end("Forbidden");
    }

    fs.readFile(filePath, (error, data) => {
        if (error) {
            res.writeHead(404, {
                "Content-Type": "text/plain; charset=utf-8"
            });

            return res.end("404 Not Found");
        }

        const ext = path.extname(filePath).toLowerCase();

        const contentTypes = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".svg": "image/svg+xml",
            ".ico": "image/x-icon"
        };

        res.writeHead(200, {
            "Content-Type":
                contentTypes[ext] || "application/octet-stream"
        });

        res.end(data);
    });
}

const server = http.createServer(serveStatic);

server.listen(PORT, "0.0.0.0", () => {
    console.log(`JGVRP server running on port ${PORT}`);
});
