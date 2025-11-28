require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

// CWA API 設定
const CWA_API_BASE_URL = "https://opendata.cwa.gov.tw/api";
const CWA_API_KEY = process.env.CWA_API_KEY;
const DATASET_ID = "F-C0032-001";

// 36 小時預報（台灣縣市）正式名稱清單（多數資料會用「臺」）
const VALID_LOCATIONS = ["臺北市", "新北市", "桃園市", "臺中市", "臺南市", "高雄市", "基隆市", "新竹市", "新竹縣", "苗栗縣", "彰化縣", "南投縣", "雲林縣", "嘉義市", "嘉義縣", "屏東縣", "宜蘭縣", "花蓮縣", "臺東縣", "澎湖縣", "金門縣", "連江縣"];

// 別名（中文常見寫法 + 英文 slug）
const LOCATION_ALIASES = {
  // 常見中文（台/臺）
  台北市: "臺北市",
  台中市: "臺中市",
  台南市: "臺南市",
  台東縣: "臺東縣",

  // 英文 slug（你前端或路由如果用 kaohsiung 這種就會命中）
  taipei: "臺北市",
  newtaipei: "新北市",
  taoyuan: "桃園市",
  taichung: "臺中市",
  tainan: "臺南市",
  kaohsiung: "高雄市",
  keelung: "基隆市",
  hsinchu_city: "新竹市",
  hsinchu_county: "新竹縣",
  miaoli: "苗栗縣",
  changhua: "彰化縣",
  nantou: "南投縣",
  yunlin: "雲林縣",
  chiayi_city: "嘉義市",
  chiayi_county: "嘉義縣",
  pingtung: "屏東縣",
  yilan: "宜蘭縣",
  hualien: "花蓮縣",
  taitung: "臺東縣",
  penghu: "澎湖縣",
  kinmen: "金門縣",
  lienchiang: "連江縣",
};

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─────────────────────────────────────────────────────────────
// 小工具
function normalizeLocation(input) {
  if (!input) return "";
  const raw = String(input).trim();

  // 先吃 aliases（含 slug / 常見中文）
  if (LOCATION_ALIASES[raw]) return LOCATION_ALIASES[raw];

  // 台→臺（只換開頭那個「台」最安全）
  const t = raw.startsWith("台") ? "臺" + raw.slice(1) : raw;

  // 再吃一次 alias（例如傳入 "臺北市" 本來就符合）
  if (LOCATION_ALIASES[t]) return LOCATION_ALIASES[t];

  return t;
}

function isValidLocation(name) {
  return VALID_LOCATIONS.includes(name);
}

function pickFirstLocation(records) {
  return records?.location?.[0] || null;
}

function safeGet(obj, path, fallback = undefined) {
  try {
    return path.split(".").reduce((acc, key) => (acc ? acc[key] : undefined), obj) ?? fallback;
  } catch {
    return fallback;
  }
}

// 簡單快取（避免一直打 CWA）
const CACHE_TTL_MS = 3 * 60 * 1000; // 3 分鐘
const cache = new Map(); // key: locationName -> { expires, data }

function getCache(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}
function setCache(key, data) {
  cache.set(key, { expires: Date.now() + CACHE_TTL_MS, data });
}

// ─────────────────────────────────────────────────────────────
// 核心：取得指定縣市 36 小時天氣
async function getWeatherByLocation(req, res) {
  try {
    if (!CWA_API_KEY) {
      return res.status(500).json({
        success: false,
        error: "伺服器設定錯誤",
        message: "請在 .env 檔案中設定 CWA_API_KEY",
      });
    }

    // 支援：?city= / ?locationName= / /api/weather/:city
    const input = req.query.city || req.query.locationName || req.params.city || req.params.location || "高雄市"; // 預設

    const locationName = normalizeLocation(input);

    if (!locationName) {
      return res.status(400).json({
        success: false,
        error: "參數錯誤",
        message: "請提供 city 或 locationName，例如 /api/weather?city=宜蘭縣",
      });
    }

    if (!isValidLocation(locationName)) {
      return res.status(400).json({
        success: false,
        error: "地區不支援",
        message: `不支援的地區：${locationName}`,
        allowed: VALID_LOCATIONS,
        tip: "請使用 /api/locations 取得可用地區清單",
      });
    }

    // cache
    const cached = getCache(locationName);
    if (cached) {
      return res.json({ success: true, data: cached, cached: true });
    }

    const url = `${CWA_API_BASE_URL}/v1/rest/datastore/${DATASET_ID}`;

    const response = await axios.get(url, {
      params: {
        Authorization: CWA_API_KEY,
        locationName,
        // 只拿前端會用到的元素（更省）
        elementName: "Wx,PoP,MinT,MaxT,CI",
        format: "JSON",
      },
      timeout: 10000,
    });

    const records = response.data?.records;
    const locationData = pickFirstLocation(records);

    if (!locationData) {
      return res.status(404).json({
        success: false,
        error: "查無資料",
        message: `無法取得 ${locationName} 天氣資料`,
      });
    }

    const weatherData = {
      city: locationData.locationName,
      updateTime: records?.datasetDescription || "三十六小時天氣預報",
      forecasts: [],
    };

    const weatherElements = locationData.weatherElement || [];

    // 以 Wx 的 time 當基準（最穩）
    const wxEl = weatherElements.find((e) => e.elementName === "Wx") || weatherElements[0];
    const baseTimes = wxEl?.time || [];
    const timeCount = baseTimes.length;

    for (let i = 0; i < timeCount; i++) {
      const forecast = {
        startTime: baseTimes[i]?.startTime || "",
        endTime: baseTimes[i]?.endTime || "",
        weather: "",
        rain: "",
        minTemp: "",
        maxTemp: "",
        comfort: "",
        windSpeed: "", // 這份 dataset 通常沒有 WS
      };

      for (const element of weatherElements) {
        const p = element?.time?.[i]?.parameter;
        const val = p?.parameterName;

        switch (element.elementName) {
          case "Wx":
            forecast.weather = val || "";
            break;
          case "PoP":
          case "PoP6h":
            forecast.rain = val !== undefined && val !== "" ? `${val}%` : "";
            break;
          case "MinT":
            forecast.minTemp = val !== undefined && val !== "" ? `${val}°C` : "";
            break;
          case "MaxT":
            forecast.maxTemp = val !== undefined && val !== "" ? `${val}°C` : "";
            break;
          case "CI":
            forecast.comfort = val || "";
            break;
          default:
            break;
        }
      }

      weatherData.forecasts.push(forecast);
    }

    setCache(locationName, weatherData);

    res.json({
      success: true,
      data: weatherData,
    });
  } catch (error) {
    console.error("取得天氣資料失敗:", error.message);

    if (error.response) {
      return res.status(error.response.status).json({
        success: false,
        error: "CWA API 錯誤",
        message: error.response.data?.message || "無法取得天氣資料",
        details: error.response.data,
      });
    }

    res.status(500).json({
      success: false,
      error: "伺服器錯誤",
      message: "無法取得天氣資料，請稍後再試",
    });
  }
}

// ─────────────────────────────────────────────────────────────
// Routes
app.get("/", (req, res) => {
  res.json({
    message: "歡迎使用 CWA 36 小時天氣預報 API",
    endpoints: {
      locations: "/api/locations",
      weatherByQuery: "/api/weather?city=宜蘭縣",
      weatherByParam: "/api/weather/宜蘭縣",
      legacyKaohsiung: "/api/weather/kaohsiung",
      health: "/api/health",
    },
  });
});

app.get("/api/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// ✅ 給前端做地區下拉選單
app.get("/api/locations", (req, res) => {
  res.json({
    success: true,
    data: VALID_LOCATIONS.map((name) => ({
      name, // 顯示用
      value: name, // 送回 API 用
    })),
  });
});

// ✅ 新：用 query 取得（建議前端用這個）
app.get("/api/weather", getWeatherByLocation);

// ✅ 新：用 path param 取得（支援中文/slug）
app.get("/api/weather/:city", getWeatherByLocation);

// ✅ 舊：保留相容（你原本前端在用）
app.get("/api/weather/kaohsiung", (req, res) => {
  req.query.city = "高雄市";
  return getWeatherByLocation(req, res);
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    error: "伺服器錯誤",
    message: err.message,
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "找不到此路徑",
  });
});

app.listen(PORT, () => {
  console.log(`🚀 伺服器運行於 port ${PORT}`);
  console.log(`📍 環境: ${process.env.NODE_ENV || "development"}`);
});
