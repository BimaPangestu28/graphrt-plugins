/**
 * The language of the messages a person reads: what is wrong with an invoice's details, its number, its file or
 * its folder. Messages are written in English where they are raised; for a document in Indonesian (`language:
 * id` in its values or look, or a saved brand in Indonesian) the operation boundary rewrites the message in
 * Indonesian. Only the text changes: the error's `kind` and other fields stay as they are, so the app maps an
 * error the same way in both languages. A message without a translation stays in English.
 */
import { DEFAULT_BRAND_NAME, resolveBrand } from "./brand-profile.mjs";

export const MESSAGE_LANGUAGES = Object.freeze(["en", "id"]);
const DEFAULT_MESSAGE_LANGUAGE = "en";

/** Indonesian words for the names in a value path (`items[0].unit_price` is "harga satuan item 1"). */
const INDONESIAN_FIELD_WORDS = Object.freeze({
  items: "daftar item",
  description: "deskripsi",
  quantity: "jumlah",
  unit: "satuan",
  unit_price: "harga satuan",
  amount: "nilai",
  discount: "diskon",
  percent: "persen",
  taxes: "pajak",
  rate: "tarif",
  name: "nama",
  address: "alamat",
  currency: "mata uang",
  date: "tanggal",
  due_date: "tanggal jatuh tempo",
  number: "nomor",
  client: "klien",
  seller: "penjual",
  shipping: "ongkos kirim",
  amount_paid: "jumlah yang sudah dibayar",
  decimals: "jumlah angka desimal",
  language: "bahasa",
  locale: "format wilayah",
  currency_style: "gaya mata uang",
  pattern: "pola nomor",
  number_pattern: "pola nomor",
  start_at: "nomor awal",
  values: "data",
  values_file: "file data",
  folder: "folder",
  file_name: "nama file",
  template: "template",
  fields: "isian formulir",
  fields_file: "file isian formulir",
  background: "latar belakang",
  logo: "logo",
  look: "tampilan",
  accent_color: "warna aksen",
  title: "judul",
  notes: "catatan",
});

/** Item lists whose entries are named "item 1" / "pajak ke-1" in a path. */
const LIST_ENTRY_NAMES = Object.freeze({ items: { en: "item", id: "item" }, taxes: { en: "tax", id: "pajak ke-" } });

/**
 * Reads a requested message language.
 *
 * @param rawLanguage - en, id, or nothing (any value)
 * @returns en or id, or null when not given or not one of them (string|null)
 */
export function readMessageLanguage(rawLanguage) {
  const language = typeof rawLanguage === "string" ? rawLanguage.trim().toLowerCase() : "";
  return MESSAGE_LANGUAGES.includes(language) ? language : null;
}

/**
 * Decides the language of a call's messages: the first of the given languages that is en or id (the call's
 * own, e.g. `values.language`, then `look.language`), else the language of the saved brand, else English.
 *
 * @param client - From createDocumentClient (object)
 * @param args - The call's arguments, for `brand` (object)
 * @param givenLanguages - Languages the call names, most specific first (any[])
 * @returns en or id (string)
 */
export async function resolveMessageLanguage(client, args, givenLanguages) {
  for (const given of givenLanguages) {
    const language = readMessageLanguage(given);
    if (language) return language;
  }
  // The brand only decides the language here; a brand that cannot be read leaves the messages in English.
  const outputRoot = await client.organiser.resolveOutputRoot().catch(() => null);
  const brand = outputRoot ? await resolveBrand(outputRoot, args?.brand ?? DEFAULT_BRAND_NAME, client.numberingDependencies).catch(() => null) : null;
  return readMessageLanguage(brand?.look?.language) ?? DEFAULT_MESSAGE_LANGUAGE;
}

/**
 * Runs an operation and, when it fails with a PluginError, writes its message in the call's language.
 *
 * @param decideLanguage - `async () => "en" | "id"`, asked only when the operation fails (function)
 * @param work - `async () => result` (function)
 * @returns What work returns
 * @throws What work throws, with the message translated; kind and the other fields unchanged
 */
export async function withMessageLanguage(decideLanguage, work) {
  try {
    return await work();
  } catch (operationError) {
    if (typeof operationError?.kind === "string" && typeof operationError.message === "string") {
      const language = await decideLanguage().catch(() => DEFAULT_MESSAGE_LANGUAGE);
      operationError.message = translateMessage(operationError.message, language);
    }
    throw operationError;
  }
}

/**
 * Words for a path into the values: `items[0].unit_price` is "the unit price of item 1" in English and
 * "harga satuan item 1" in Indonesian; `client.name` is "client name" and "nama klien".
 *
 * @param path - A value path as messages write it (string)
 * @param language - en or id (string)
 * @returns The path in words (string)
 */
export function describeValuePath(path, language) {
  const parts = String(path).replace(/^values\./, "").split(".");
  const entry = /^([a-z_]+)\[(\d+)\]$/.exec(parts[0]);
  if (language === "id") {
    const words = parts.slice(1).reverse().map(toIndonesianWord);
    if (entry) words.push(LIST_ENTRY_NAMES[entry[1]]?.id === "pajak ke-" ? `pajak ke-${Number(entry[2]) + 1}` : `${LIST_ENTRY_NAMES[entry[1]]?.id ?? toIndonesianWord(entry[1])} ${Number(entry[2]) + 1}`);
    else words.push(toIndonesianWord(parts[0]));
    return words.join(" ");
  }
  if (entry) {
    const entryName = `${LIST_ENTRY_NAMES[entry[1]]?.en ?? entry[1].replaceAll("_", " ")} ${Number(entry[2]) + 1}`;
    return parts.length > 1 ? `the ${parts.slice(1).join(" ").replaceAll("_", " ")} of ${entryName}` : entryName;
  }
  return parts.join(" ").replaceAll("_", " ");
}

function toIndonesianWord(name) {
  return INDONESIAN_FIELD_WORDS[name] ?? name.replaceAll("_", " ");
}

const PATH = "([a-z_]+(?:\\[\\d+\\])?(?:\\.[a-z_]+)*)";

// English message, anchored, and its Indonesian text. `field(path)` writes a value path in Indonesian.
const field = (path) => describeValuePath(path, "id");
const INDONESIAN_MESSAGES = [
  // Amounts and the invoice calculation.
  [new RegExp(`^\`${PATH}\` must be a plain number such as 1500000 or 1500000\\.50 \\(no thousands separators or currency symbols\\), got (.*)$`), (path, got) => `${field(path)} harus berupa angka biasa seperti 1500000 atau 1500000.50 (tanpa pemisah ribuan atau simbol mata uang), bukan ${got}`],
  [new RegExp(`^\`${PATH}\` is too large$`), (path) => `${field(path)} terlalu besar`],
  [new RegExp(`^\`${PATH}\` must be a finite number$`), (path) => `${field(path)} harus berupa angka`],
  [/^`values\.items` must be a list of line items$/, () => "Daftar item harus berupa daftar baris item"],
  [/^`values\.items` has (\d+) entries, over the limit of (\d+)$/, (count, limit) => `Daftar item berisi ${count} baris, melebihi batas ${limit}`],
  [new RegExp(`^\`${PATH}\` must be an object with a description and an amount, or a quantity and unit_price$`), (path) => `${field(path)} harus berisi deskripsi dan nilai, atau jumlah dan harga satuan`],
  [new RegExp(`^\`${PATH}\` needs \`amount\`, or \`quantity\` and \`unit_price\`$`), (path) => `${field(path)} perlu nilai, atau jumlah dan harga satuan`],
  [new RegExp(`^\`${PATH}\` is (\\S+) but quantity x unit_price less its discount is (\\S+); correct one of them or leave \`amount\` out$`), (path, given, computed) => `${field(path)} tertulis ${given}, padahal jumlah x harga satuan dikurangi diskon adalah ${computed}; perbaiki salah satunya atau kosongkan nilainya`],
  [new RegExp(`^\`${PATH}\` is required when \`quantity\` is given$`), (path) => `${field(path)} wajib diisi bila jumlah diisi`],
  [new RegExp(`^\`${PATH}\` takes \`percent\` or \`amount\`, not both$`), (path) => `${field(path)} diisi persen atau nilai, tidak keduanya`],
  [new RegExp(`^\`${PATH}\` must be a number, or an object with \`percent\` or \`amount\`$`), (path) => `${field(path)} harus berupa angka, atau berisi persen atau nilai`],
  [new RegExp(`^\`${PATH}\` must not be negative$`), (path) => `${field(path)} tidak boleh negatif`],
  [/^`taxes` must be a list such as .*$/, () => "Pajak harus berupa daftar seperti [{\"name\": \"PPN\", \"rate\": 11}]"],
  [/^`taxes` has (\d+) entries, over the limit of (\d+)$/, (count, limit) => `Pajak berisi ${count} baris, melebihi batas ${limit}`],
  [/^`taxes\[(\d+)\]` needs `name` and `rate` \(a percentage; negative for a withholding\)$/, (index) => `Pajak ke-${Number(index) + 1} perlu nama dan tarif (persen; negatif untuk potongan pajak)`],
  [new RegExp(`^\`${PATH}\` must be a percentage from -100 to 100$`), (path) => `${field(path)} harus berupa persen dari -100 sampai 100`],
  // Currency, language and formats.
  [/^`currency` must be a three-letter code such as IDR or USD, got (.*)$/, (got) => `Mata uang harus berupa kode tiga huruf seperti IDR atau USD, bukan ${got}`],
  [/^`decimals` must be an integer from 0 to (\d+), got (.*)$/, (max, got) => `Jumlah angka desimal harus bilangan bulat dari 0 sampai ${max}, bukan ${got}`],
  [/^`locale` must be a language tag such as en-GB or id-ID, got (.*)$/, (got) => `Format wilayah harus seperti en-GB atau id-ID, bukan ${got}`],
  [new RegExp(`^\`${PATH}\` must be en \\(English\\) or id \\(Indonesian\\), got (.*)$`), (path, got) => `${field(path)} harus en (Inggris) atau id (Indonesia), bukan ${got}`],
  [new RegExp(`^\`${PATH}\` must be one of (.*), got (.*)$`), (path, choices, got) => `${field(path)} harus salah satu dari ${choices}, bukan ${got}`],
  [/^`date` must be a date such as 2026-11-27, got (.*)$/, (got) => `Tanggal harus seperti 2026-11-27, bukan ${got}`],
  // The values themselves.
  [/^Pass `values` or `values_file`, not both$/, () => "Berikan data atau file data, tidak keduanya"],
  [/^`values` is required: .*$/, () => "Data dokumen wajib diisi"],
  [/^The (.+) template needs these values: (.+)\. describe_template shows every field with an example$/, (template, fields) => `Template ${template} memerlukan data berikut: ${fields.split(", ").map(field).join(", ")}`],
  [/^Give the document's `number` in `values` or a `number_pattern`, not both$/, () => "Berikan nomor dokumen di data atau pola nomor, tidak keduanya"],
  // Running numbers.
  [/^`pattern` must be a text of at most (\d+) characters such as (.*)$/, (max, example) => `Pola nomor harus berupa teks paling banyak ${max} karakter, seperti ${example}`],
  [/^`pattern` needs exactly one \{SEQ\} token .*$/, () => "Pola nomor harus punya tepat satu {SEQ} (atau {SEQ:4} untuk empat digit), misalnya INV-{YYYY}-{SEQ:4}"],
  [/^`pattern` may use letters, digits, .*$/, () => "Pola nomor hanya boleh berisi huruf, angka, spasi, . _ - / # dan {YYYY} {YY} {MM} {DD} {ROMAN} {SEQ}"],
  [/^The numbering file already has (\d+) counters; remove old ones from (.*)$/, (count, file) => `File penomoran sudah berisi ${count} seri nomor; hapus seri lama dari ${file}`],
  [/^The counter (.*) in (.*) has an invalid value$/, (counter, file) => `Seri nomor ${counter} di ${file} berisi nilai yang tidak valid`],
  [/^(.*) is damaged \((.*)\); repair or remove it, then pass `start_at` to continue the numbering$/, (file, reason) => `${file} rusak (${reason}); perbaiki atau hapus file itu, lalu isi nomor awal untuk melanjutkan penomoran`],
  [/^Could not read the numbering file: (.*)$/, (reason) => `File penomoran tidak bisa dibaca: ${reason}`],
  [/^Could not write the numbering file: (.*)$/, (reason) => `File penomoran tidak bisa ditulis: ${reason}`],
  [/^Could not lock the numbering file: (.*)$/, (reason) => `File penomoran tidak bisa dikunci: ${reason}`],
  [/^Another call is issuing a number and did not finish within 5 seconds; try again$/, () => "Ada proses lain yang sedang mengambil nomor dan belum selesai dalam 5 detik; coba lagi"],
  [/^The document was not saved, and the number (.*) could not be given back \((.*)\); the next document gets the number after it$/, (number, reason) => `Dokumen tidak tersimpan, dan nomor ${number} tidak bisa dikembalikan (${reason}); dokumen berikutnya mendapat nomor sesudahnya`],
  [/^Other documents kept taking the next number of (.*); nothing was saved and no number was used\. Try again$/, (pattern) => `Dokumen lain terus mengambil nomor berikutnya dari ${pattern}; tidak ada yang disimpan dan tidak ada nomor yang terpakai. Coba lagi`],
  // Files and folders.
  [/^(".*") already exists; nothing was saved\. Use another number or file name, or `if_exists: number` to keep both$/, (file) => `${file} sudah ada; tidak ada yang disimpan. Pakai nomor atau nama file lain, atau if_exists: number untuk menyimpan keduanya`],
  [/^(".*") and (\d+) numbered copies already exist; nothing was saved$/, (file, copies) => `${file} dan ${copies} salinan bernomornya sudah ada; tidak ada yang disimpan`],
  [/^(".*") is not a plain file \(.*\) and cannot be overwritten$/, (file) => `${file} bukan file biasa (tautan, folder, atau file dengan beberapa hard link) dan tidak bisa ditimpa`],
  [/^The document is (\d+) bytes, over the (\d+)-byte limit \((.*)\); nothing was saved$/, (size, limit, setting) => `Dokumen berukuran ${size} byte, melebihi batas ${limit} byte (${setting}); tidak ada yang disimpan`],
  [/^Could not save the document: (.*)$/, (reason) => `Dokumen tidak bisa disimpan: ${reason}`],
  [/^Could not create the folder (.*): (.*)$/, (folder, reason) => `Folder ${folder} tidak bisa dibuat: ${reason}`],
  [/^The folder (".*") leads outside (\S+) or is not a folder$/, (folder, setting) => `Folder ${folder} mengarah ke luar ${setting} atau bukan folder`],
  [/^`folder` has (\d+) levels, over the limit of (\d+)$/, (levels, limit) => `Folder punya ${levels} tingkat, melebihi batas ${limit}`],
  [/^`file_name` must not contain \/ or \\; use `folder` for the folder$/, () => "Nama file tidak boleh berisi / atau \\; pakai pengaturan folder untuk foldernya"],
  [/^`(folder|file_name)` has a malformed token in (.*); tokens look like \{YYYY\} or \{number\}$/, (parameter, pattern) => `${field(parameter)} berisi penanda yang salah di ${pattern}; penanda ditulis seperti {YYYY} atau {number}`],
  [/^`(folder|file_name)` uses \{(.*)\}, but the values have no usable text for it$/, (parameter, token) => `${field(parameter)} memakai {${token}}, tetapi datanya tidak punya teks untuk itu`],
  [/^`(folder|file_name)` resolves to an empty name$/, (parameter) => `${field(parameter)} menjadi nama kosong`],
  [/^`(folder|file_name)` uses the unknown token \{(.*?)\}; tokens: (.*)$/, (parameter, token, tokens) => `${field(parameter)} memakai penanda {${token}} yang tidak dikenal; penanda yang ada: ${tokens}`],
  [/^`if_exists: overwrite` is for workflow nodes only; .*$/, () => "if_exists: overwrite hanya untuk langkah workflow; pakai number untuk menyimpan salinan bernomor, atau nama file lain"],
  [/^Set (\S+) to the folder \(absolute, or ~\/\.\.\.\) where documents are saved$/, (setting) => `Isi ${setting} dengan folder (lengkap, atau ~/...) tempat dokumen disimpan`],
  [/^(\S+) \((.*)\) must be an existing folder$/, (setting, folder) => `${setting} (${folder}) harus berupa folder yang sudah ada`],
  [/^No file at (".*") inside (.*)$/, (file, folders) => `Tidak ada file ${file} di dalam ${folders}`],
  [/^(".*") is not a regular file$/, (file) => `${file} bukan file biasa`],
  [/^(".*") is (\d+) bytes, over the (\d+)-byte limit \((.*)\)$/, (file, size, limit, setting) => `${file} berukuran ${size} byte, melebihi batas ${limit} byte (${setting})`],
  [/^`([a-z_]+)` must be a (.*) file$/, (parameter, extensions) => `${field(parameter)} harus berupa file ${extensions}`],
  [/^`([a-z_]+)` is not a PDF file \(no %PDF- header\)$/, (parameter) => `${field(parameter)} bukan file PDF`],
  [/^`template` must be a built-in template \((.*)\) or a \.json, \.docx, \.dotx or \.pdf file, got (.*)$/, (names, got) => `Template harus template bawaan (${names}) atau file .json, .docx, .dotx atau .pdf, bukan ${got}`],
  // Logo and images.
  [/^(.*) is (.*); a logo may be at most 2 MB\. .*$/, (logo, size) => `${toIndonesianSubject(logo)} berukuran ${size}; logo paling besar 2 MB. Simpan versi yang lebih kecil (lebar sekitar 800 piksel sudah cukup)`],
  [/^(.*) is not a usable picture: it is damaged or smaller than (\d+) pixels$/, (logo, pixels) => `${toIndonesianSubject(logo)} bukan gambar yang bisa dipakai: rusak atau lebih kecil dari ${pixels} piksel`],
  [/^(.*) is (\d+) x (\d+) pixels; a logo may be at most (\d+) pixels on each side\. .*$/, (logo, width, height, max) => `${toIndonesianSubject(logo)} berukuran ${width} x ${height} piksel; logo paling besar ${max} piksel di tiap sisi. Simpan versi yang lebih kecil (lebar sekitar 800 piksel sudah cukup)`],
  [/^(.*) must be a (.*) image \(detected from its content: (.*)\)$/, (image, formats, detected) => `${toIndonesianSubject(image)} harus berupa gambar ${formats} (terbaca dari isinya: ${detected === "not a supported image" ? "bukan gambar yang didukung" : detected})`],
  [/^An image could not be read \((.*)\); save it again as a PNG or JPEG$/, (reason) => `Sebuah gambar tidak bisa dibaca (${reason}); simpan lagi sebagai PNG atau JPEG`],
  [/^No available font has these characters: (.*)\. The built-in fonts cover Latin, Vietnamese, Cyrillic and Greek; for other scripts set (\S+) to a font file (.*)$/, (characters, setting, file) => `Tidak ada font yang punya huruf ini: ${characters}. Font bawaan mencakup huruf Latin, Vietnam, Sirilik dan Yunani; untuk aksara lain isi ${setting} dengan file font ${file.replace("that has them", "yang memilikinya").replace(" or ", " atau ")}`],
  [/^The document has (\d+) pages, over the (\d+)-page limit \((.*)\)$/, (pages, limit, setting) => `Dokumen ini ${pages} halaman, melebihi batas ${limit} halaman (${setting})`],
  [/^`([a-z_.]+)` (".*") is too light: .*$/, (path, color) => `${field(path)} ${color} terlalu terang: nama usaha dan total dicetak dengan warna ini di kertas putih dan tidak akan terbaca. Pilih warna yang lebih gelap`],
  // PDF forms and Word templates.
  [/^The PDF has no form field named (.*)\. Its fields: (.*)$/, (names, fields) => `PDF ini tidak punya kotak isian bernama ${names}. Kotak isiannya: ${fields}`],
  [/^The value for the form field (".*") must be a text, a number or true\/false$/, (name) => `Isian untuk kotak ${name} harus berupa teks, angka, atau true/false`],
  [/^The value for the form field (".*") was not accepted: (.*)$/, (name, reason) => `Isian untuk kotak ${name} tidak diterima: ${reason}`],
  [/^The value for (".*") is longer than (\d+) characters$/, (name, max) => `Isian untuk ${name} lebih dari ${max} karakter`],
  [/^This PDF has no fillable form fields\. .*$/, () => "PDF ini tidak punya kotak isian. PDF berupa gambar atau halaman biasa tidak bisa diisi; pakai template invoice bawaan, atau template tata letak dengan PDF ini sebagai latar belakang"],
  [/^Pass `fields` or `fields_file`, not both$/, () => "Berikan isian formulir atau file isian formulir, tidak keduanya"],
  [/^`fields` is required: .*$/, () => "Isian formulir wajib diisi: nama kotak isian dan nilainya"],
  [/^`fields` must name 1 to (\d+) form fields$/, (max) => `Isian formulir harus menyebut 1 sampai ${max} kotak isian`],
  [/^The template is not a Word document \(\.docx\): .*$/, () => "Template ini bukan dokumen Word (.docx). Simpan file .doc, .odt atau .pages sebagai .docx dulu"],
  [/^The template contains macros \(\.docm\); .*$/, () => "Template ini berisi macro (.docm); simpan sebagai .docx biasa tanpa macro"],
  [/^The Word template has a problem with its placeholders: (.*)$/, (details) => `Template Word ini punya masalah pada penanda isiannya: ${details}`],
];

// "The logo "logo.png"" / "The image "x.png"" in Indonesian.
function toIndonesianSubject(subject) {
  return subject.replace(/^The logo /, "Logo ").replace(/^The image /, "Gambar ").replace(/^`([a-z_.]+)`$/, (_match, path) => describeValuePath(path, "id"));
}

/**
 * Writes a message in the given language; English stays as it is, as does a message without a translation.
 *
 * @param message - An English PluginError message (string)
 * @param language - en or id (string)
 * @returns The message in that language (string)
 */
export function translateMessage(message, language) {
  if (language !== "id") return message;
  for (const [pattern, translate] of INDONESIAN_MESSAGES) {
    const match = pattern.exec(message);
    if (match) {
      const translated = translate(...match.slice(1));
      return translated.charAt(0).toUpperCase() + translated.slice(1);
    }
  }
  return message;
}

/**
 * A message in the words a person reads most easily: in English, value paths written out (`items[0].unit_price`
 * becomes "the unit price of item 1"); in Indonesian, the translated message.
 *
 * @param message - An English PluginError message (string)
 * @param language - en or id (string)
 * @returns The message, starting with a capital letter (string)
 */
export function toPlainProblem(message, language = DEFAULT_MESSAGE_LANGUAGE) {
  const translated = translateMessage(String(message), language);
  const plain = translated
    .replace(new RegExp(`\`([a-z_]+\\[\\d+\\](?:\\.[a-z_]+)*)\``, "g"), (_match, path) => describeValuePath(path, language))
    .replace(/`([a-z][a-z_]*(?:\.[a-z][a-z_]*)*)`/g, (_match, path) => describeValuePath(path, language));
  return plain.charAt(0).toUpperCase() + plain.slice(1);
}
