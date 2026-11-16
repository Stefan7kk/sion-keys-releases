// Name, navigation, upload, URL prompt, results, and tabs.
export const languages = {
  en: ["English", "Analyze", "History", "Settings", "About", "Donation", "Drag and drop an audio file", "Paste a YouTube link", "Key", "Detected Chords", "Timeline", "Lyrics Sheet", "Chord Diagrams", "Key Details", "Analysis"],
  bg: ["Български", "Анализирай", "История", "Настройки", "За приложението", "Дарение", "Плъзнете и пуснете аудиофайл", "Поставете връзка от YouTube", "Тоналност", "Открити акорди", "Времева линия", "Списък с акорди", "Диаграми на акорди", "За тоналността", "Анализ"],
  he: ["עברית", "ניתוח", "היסטוריה", "הגדרות", "אודות", "תרומה", "גררו ושחררו קובץ שמע", "הדביקו קישור ל־YouTube", "סולם", "אקורדים שזוהו", "ציר הזמן", "דף מילים", "תרשימי אקורדים", "פרטי הסולם", "ניתוח"],
  tr: ["Türkçe", "Analiz et", "Geçmiş", "Ayarlar", "Hakkında", "Bağış", "Bir ses dosyasını sürükleyip bırakın", "YouTube bağlantısını yapıştırın", "Tonalite", "Tespit edilen akorlar", "Zaman çizelgesi", "Akor listesi", "Akor şemaları", "Tonalite bilgisi", "Analiz"],
  es: ["Español", "Analizar", "Historial", "Ajustes", "Acerca de", "Donar", "Arrastra un archivo de audio", "Pega un enlace de YouTube", "Tonalidad", "Acordes detectados", "Cronología", "Lista de acordes", "Diagramas de acordes", "Detalles de tonalidad", "Análisis"],
  fr: ["Français", "Analyser", "Historique", "Paramètres", "À propos", "Faire un don", "Déposez un fichier audio", "Collez un lien YouTube", "Tonalité", "Accords détectés", "Chronologie", "Liste des accords", "Diagrammes d’accords", "Détails de tonalité", "Analyse"],
  de: ["Deutsch", "Analysieren", "Verlauf", "Einstellungen", "Über die App", "Spenden", "Audiodatei hierher ziehen", "YouTube-Link einfügen", "Tonart", "Erkannte Akkorde", "Zeitleiste", "Akkordliste", "Akkorddiagramme", "Tonartdetails", "Analyse"],
  pt: ["Português", "Analisar", "Histórico", "Configurações", "Sobre", "Doar", "Arraste um arquivo de áudio", "Cole um link do YouTube", "Tonalidade", "Acordes detectados", "Linha do tempo", "Lista de acordes", "Diagramas de acordes", "Detalhes da tonalidade", "Análise"],
  it: ["Italiano", "Analizza", "Cronologia", "Impostazioni", "Informazioni", "Dona", "Trascina un file audio", "Incolla un link YouTube", "Tonalità", "Accordi rilevati", "Linea temporale", "Lista accordi", "Diagrammi degli accordi", "Dettagli tonalità", "Analisi"],
  ru: ["Русский", "Анализировать", "История", "Настройки", "О приложении", "Поддержать", "Перетащите аудиофайл", "Вставьте ссылку YouTube", "Тональность", "Найденные аккорды", "Шкала времени", "Список аккордов", "Схемы аккордов", "О тональности", "Анализ"],
  zh: ["简体中文", "分析", "历史", "设置", "关于", "捐助", "拖放音频文件", "粘贴 YouTube 链接", "调性", "检测到的和弦", "时间轴", "和弦列表", "和弦图", "调性详情", "分析详情"],
  ja: ["日本語", "解析", "履歴", "設定", "アプリについて", "寄付", "音声ファイルをドロップ", "YouTube リンクを貼り付け", "キー", "検出されたコード", "タイムライン", "コード一覧", "コード図", "キーの詳細", "解析結果"],
  ko: ["한국어", "분석", "기록", "설정", "앱 소개", "후원", "오디오 파일을 끌어 놓으세요", "YouTube 링크를 붙여 넣으세요", "조성", "감지된 코드", "타임라인", "코드 목록", "코드 다이어그램", "조성 정보", "분석 결과"],
  ar: ["العربية", "تحليل", "السجل", "الإعدادات", "حول", "تبرع", "اسحب ملفًا صوتيًا وأفلته هنا", "ألصق رابط يوتيوب", "المقام", "التآلفات المكتشفة", "الخط الزمني", "قائمة التآلفات", "مخططات التآلفات", "تفاصيل المقام", "نتائج التحليل"],
  hi: ["हिन्दी", "विश्लेषण करें", "इतिहास", "सेटिंग्स", "परिचय", "सहयोग करें", "ऑडियो फ़ाइल यहाँ खींचें", "YouTube लिंक पेस्ट करें", "स्वरमान", "पहचाने गए कॉर्ड", "समयरेखा", "कॉर्ड सूची", "कॉर्ड आरेख", "स्वरमान विवरण", "विश्लेषण"],
  bn: ["বাংলা", "বিশ্লেষণ করুন", "ইতিহাস", "সেটিংস", "পরিচিতি", "অনুদান", "অডিও ফাইল এখানে টেনে আনুন", "YouTube লিংক পেস্ট করুন", "সুরের কী", "শনাক্ত কর্ড", "টাইমলাইন", "কর্ড তালিকা", "কর্ড চিত্র", "কী-এর বিবরণ", "বিশ্লেষণ"],
  id: ["Bahasa Indonesia", "Analisis", "Riwayat", "Pengaturan", "Tentang", "Donasi", "Seret dan lepas berkas audio", "Tempel tautan YouTube", "Nada dasar", "Akor terdeteksi", "Linimasa", "Daftar akor", "Diagram akor", "Detail nada dasar", "Hasil analisis"],
  ur: ["اردو", "تجزیہ کریں", "سابقہ نتائج", "ترتیبات", "تعارف", "عطیہ", "آڈیو فائل یہاں کھینچ کر چھوڑیں", "یوٹیوب لنک چسپاں کریں", "موسیقی کی کلید", "شناخت شدہ کارڈز", "ٹائم لائن", "کارڈز کی فہرست", "کارڈز کے خاکے", "کلید کی تفصیلات", "تجزیہ"],
  vi: ["Tiếng Việt", "Phân tích", "Lịch sử", "Cài đặt", "Giới thiệu", "Ủng hộ", "Kéo thả tệp âm thanh", "Dán liên kết YouTube", "Giọng", "Hợp âm phát hiện", "Dòng thời gian", "Danh sách hợp âm", "Sơ đồ hợp âm", "Chi tiết giọng", "Kết quả phân tích"],
  th: ["ไทย", "วิเคราะห์", "ประวัติ", "การตั้งค่า", "เกี่ยวกับ", "สนับสนุน", "ลากไฟล์เสียงมาวางที่นี่", "วางลิงก์ YouTube", "คีย์", "คอร์ดที่ตรวจพบ", "ไทม์ไลน์", "รายการคอร์ด", "แผนภาพคอร์ด", "รายละเอียดคีย์", "ผลการวิเคราะห์"],
  pl: ["Polski", "Analizuj", "Historia", "Ustawienia", "O aplikacji", "Wesprzyj", "Przeciągnij plik audio", "Wklej link z YouTube", "Tonacja", "Wykryte akordy", "Oś czasu", "Lista akordów", "Diagramy akordów", "Szczegóły tonacji", "Analiza"],
  uk: ["Українська", "Аналізувати", "Історія", "Налаштування", "Про застосунок", "Підтримати", "Перетягніть аудіофайл", "Вставте посилання YouTube", "Тональність", "Знайдені акорди", "Шкала часу", "Список акордів", "Схеми акордів", "Деталі тональності", "Аналіз"],
  ro: ["Română", "Analizează", "Istoric", "Setări", "Despre", "Donează", "Trage un fișier audio aici", "Lipește un link YouTube", "Tonalitate", "Acorduri detectate", "Cronologie", "Lista acordurilor", "Diagrame de acorduri", "Detalii tonalitate", "Analiză"],
} as const;

export type Language = keyof typeof languages;
export type LyricsLanguage = "auto" | Language;
export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && Object.hasOwn(languages, value);
}

export function languageDirection(language: string) {
  return language === "ar" || language === "he" || language === "ur" ? "rtl" : "ltr";
}

export const navLabels = { analyze: 1, history: 2, settings: 3, about: 4 } as const;
