// COPY & PASTE THE CONTENTS FROM THE BELOW JAVASCRIPT LIBRARY HERE
// https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.1.1/crypto-js.min.js
// This is the same library used by https://github.com/RogueEdit/offlineRogueEditor/blob/main/SavefileConverter/index.html
// </START-PASTE>

// </END-PASTE>

function EvpKDF(password, salt) {
  const keySize = 256 / 32
  const ivSize = 128 / 32
  const iterations = 1
  const key = CryptoJS.enc.Utf8.parse(password)
  const keyMaterial = CryptoJS.algo.EvpKDF.create({
    keySize: keySize + ivSize,
    iterations: iterations,
    hasher: CryptoJS.algo.MD5,
  }).compute(key, salt)
  const iv = CryptoJS.lib.WordArray.create(
    keyMaterial.words.slice(keySize, keySize + ivSize)
  )
  const derivedKey = CryptoJS.lib.WordArray.create(
    keyMaterial.words.slice(0, keySize)
  )
  return {
    key: derivedKey,
    iv: iv,
  }
}

function decrypt(fileContent) {
  const rawData = CryptoJS.enc.Base64.parse(fileContent)
  const rawStr = CryptoJS.enc.Latin1.stringify(rawData)
  const saltedMagic = rawStr.substr(0, 8)
  if (saltedMagic !== 'Salted__') {
    alert('Invalid file format.')
    return
  }
  const salt = CryptoJS.enc.Latin1.parse(rawStr.substr(8, 8))
  const encrypted = CryptoJS.enc.Latin1.parse(rawStr.substr(16))
  const password = 'x0i2O7WRiANTqPmZ'
  const keyAndIV = EvpKDF(password, salt)
  const key = keyAndIV.key
  const iv = keyAndIV.iv
  const decrypted = CryptoJS.AES.decrypt({ ciphertext: encrypted }, key, {
    iv: iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  })
  const decryptedText = decrypted.toString(CryptoJS.enc.Utf8)
  return decryptedText
}

function openAttachmentDialog() {
  var html = HtmlService.createHtmlOutputFromFile('UploadPlayerData')
  SpreadsheetApp.getUi().showModalDialog(html, 'Upload File')
}

function createBlob(obj) {
  const decodedData = Utilities.base64Decode(obj.data)
  const blob = Utilities.newBlob(decodedData, obj.mimeType, obj.fileName)
  return blob
}

function decryptFile(blob) {
  const fileContent = blob.getDataAsString('utf-8')
  var cipher = new cCryptoGS.Cipher('x0i2O7WRiANTqPmZ')
  var decrypted = cipher.decrypt(fileContent)
  return decrypted
}

function formatJsonWithoutQuotes(obj, indent = 2) {
  function format(value, depth) {
    if (typeof value === 'object' && value !== null) {
      const isArray = Array.isArray(value)
      const entries = Object.entries(value).map(([key, val]) => {
        const formattedKey = isArray ? '' : `${key}: `
        const formattedValue = format(val, depth + 1)
        return `${' '.repeat(depth * indent)}${formattedKey}${formattedValue}`
      })
      if (isArray) {
        return `[\n${entries.join(',\n')}\n${' '.repeat((depth - 1) * indent)}]`
      } else {
        return `{\n${entries.join(',\n')}\n${' '.repeat((depth - 1) * indent)}}`
      }
    } else if (typeof value === 'string') {
      return `"${value}"`
    } else {
      return String(value)
    }
  }
  return format(obj, 1)
}

function parseJsonContent(plaintext) {
  var jsonContent = JSON.parse(plaintext)

  for (const key in jsonContent.starterData) {
    if (jsonContent.starterData.hasOwnProperty(key)) {
      jsonContent.starterData[key]['$m'] = null
    }
  }

  for (const key in jsonContent.dexData) {
    if (jsonContent.dexData.hasOwnProperty(key)) {
      jsonContent.dexData[key]['$sa'] = BigInt(jsonContent.dexData[key]['$sa'])
        .toString(2)
        .padStart()
      jsonContent.dexData[key]['$ca'] = BigInt(jsonContent.dexData[key]['$ca'])
        .toString(2)
        .padStart()
      jsonContent.dexData[key]['$na'] = BigInt(jsonContent.dexData[key]['$na'])
        .toString(2)
        .padStart()
      jsonContent.dexData[key]['ribbons'] = parseInt(
        jsonContent.dexData[key]['ribbons'],
        16
      ).toString(2)
    }
  }
  return jsonContent
}

function writeJsonToSheet(jsonContent) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('newJSON')
  var startRow = 1

  const jsonString = formatJsonWithoutQuotes(jsonContent, 0)
  const jsonLines = jsonString.split('\n')
  const values = jsonLines.map((line) => [line.trim()])

  sheet.getRange(startRow, 1, values.length, 1).setValues(values)
}

// ============================================================
// MODIFIED uploadFile: integrates with OfflineDexLib for
// snapshot tracking and change highlighting.
// ============================================================
function uploadFile(obj) {
  const ss = SpreadsheetApp.getActiveSpreadsheet()
  OfflineDexLib.resetToastProgress()
  OfflineDexLib.startStep(ss, 'Importing Save Data')

  var blob = createBlob(obj)
  var plaintext = decryptFile(blob)
  var jsonContent = parseJsonContent(plaintext)
  writeJsonToSheet(jsonContent)
  SpreadsheetApp.flush()
  Utilities.sleep(2000)

  OfflineDexLib.finishStep()

  try {
    OfflineDexLib.processChanges()
  } catch (e) {
    Logger.log('processChanges failed: ' + e.message)
  }
}
