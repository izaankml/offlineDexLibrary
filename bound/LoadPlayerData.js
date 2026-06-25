// COPY & PASTE THE CONTENTS FROM THE BELOW JAVASCRIPT LIBRARY HERE
// https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.1.1/crypto-js.min.js
// This is the same library used by https://github.com/RogueEdit/offlineRogueEditor/blob/main/SavefileConverter/index.html
// </START-PASTE>

// </END-PASTE>


// OpenSSL key and IV derivation function
// Not currently used
function EvpKDF(password, salt) {
  // Define the key size in words (256 bits / 32 bits per word)
  const keySize = 256 / 32;

  // Define the IV size in words (128 bits / 32 bits per word)
  const ivSize = 128 / 32;

  // Number of iterations for the key derivation function (set to 1)
  const iterations = 1;

  // Convert the password to a UTF-8 encoded word array
  const key = CryptoJS.enc.Utf8.parse(password);

  // Create the key material using the EvpKDF function with MD5 as the hashing algorithm
  const keyMaterial = CryptoJS.algo.EvpKDF.create({
    keySize: keySize + ivSize,  // Total size of the derived key material
    iterations: iterations,     // Number of iterations for the KDF
    hasher: CryptoJS.algo.MD5   // Hashing algorithm used in the KDF
  }).compute(key, salt);        // Compute the key material using the password and salt
  
  // Extract the IV from the key material (the last part of the key material)
  const iv = CryptoJS.lib.WordArray.create(keyMaterial.words.slice(keySize, keySize + ivSize));

  // Extract the derived key from the key material (the first part of the key material)
  const derivedKey = CryptoJS.lib.WordArray.create(keyMaterial.words.slice(0, keySize));

  // Return an object containing the derived key and IV
  return {
    key: derivedKey,
    iv: iv
  };
}

// Not currently used
function decrypt(fileContent) {
  // Decode the Base64 encoded file content
  const rawData = CryptoJS.enc.Base64.parse(fileContent);
  const rawStr = CryptoJS.enc.Latin1.stringify(rawData);

  // Extract the first 8 characters to check for the "Salted__" magic string
  const saltedMagic = rawStr.substr(0, 8);
  if (saltedMagic !== "Salted__") {
    alert('Invalid file format.');
    return;
  }

  // Extract the salt (next 8 characters after the magic string)
  const salt = CryptoJS.enc.Latin1.parse(rawStr.substr(8, 8));

  // Extract the encrypted data (remaining part of the string)
  const encrypted = CryptoJS.enc.Latin1.parse(rawStr.substr(16));

  // Password used for deriving the decryption key and IV
  const password = "x0i2O7WRiANTqPmZ";

  // Derive the decryption key and IV using the password and extracted salt
  const keyAndIV = EvpKDF(password, salt);
  const key = keyAndIV.key;
  const iv = keyAndIV.iv;

  // Decrypt the encrypted data using AES with the derived key and IV
  const decrypted = CryptoJS.AES.decrypt(
    { ciphertext: encrypted },
    key, {
    iv: iv,
    mode: CryptoJS.mode.CBC,      // Using Cipher Block Chaining (CBC) mode
    padding: CryptoJS.pad.Pkcs7   // Using PKCS7 padding
  }
  );

  // Convert the decrypted data to a UTF-8 encoded string
  const decryptedText = decrypted.toString(CryptoJS.enc.Utf8);
  return decryptedText;
}

function openAttachmentDialog() {
  var html = HtmlService.createHtmlOutputFromFile('UploadPlayerData');
  SpreadsheetApp.getUi() 
    .showModalDialog(html, 'Upload File');
}

function createBlob(obj) {
  // Decode the Base64 encoded data in the obj
  const decodedData = Utilities.base64Decode(obj.data);

  // Create a new Blob with the decoded data, specified MIME type, and file name
  const blob = Utilities.newBlob(decodedData, obj.mimeType, obj.fileName);

  return blob;
}

function decryptFile(blob) {
  // Get the file content as a UTF-8 encoded string
  const fileContent = blob.getDataAsString('utf-8');

  // Decrypt the file content using AES with the given password
  //const decrypted = CryptoJS.AES.decrypt(fileContent, "x0i2O7WRiANTqPmZ");

  // Convert the decrypted data to a UTF-8 encoded string and return it
  //return decrypted.toString(CryptoJS.enc.Utf8);

  var cipher = new cCryptoGS.Cipher("x0i2O7WRiANTqPmZ");
  var decrypted = cipher.decrypt(fileContent);
  return decrypted;
}

// Function to format a JSON object without quotes around keys
function formatJsonWithoutQuotes(obj, indent = 2) {
  // Helper function to format each value recursively
  function format(value, depth) {
    // Check if the value is an object or array
    if (typeof value === 'object' && value !== null) {
      const isArray = Array.isArray(value); // Determine if the value is an array
      // Map over the entries of the object or array
      const entries = Object.entries(value).map(([key, val]) => {
        const formattedKey = isArray ? '' : `${key}: `; // Format the key if it's an object
        const formattedValue = format(val, depth + 1); // Recursively format the value
        // Return the formatted key-value pair with appropriate indentation
        return `${' '.repeat(depth * indent)}${formattedKey}${formattedValue}`;
      });
      // Format the result as an array or object
      if (isArray) {
        return `[\n${entries.join(',\n')}\n${' '.repeat((depth - 1) * indent)}]`;
      } else {
        return `{\n${entries.join(',\n')}\n${' '.repeat((depth - 1) * indent)}}`;
      }
    } else if (typeof value === 'string') {
      // Format strings with quotes
      return `"${value}"`;
    } else {
      // Format other types (numbers, booleans, etc.) as strings
      return String(value);
    }
  }
  // Start formatting the object with an initial depth of 1
  return format(obj, 1);
}

function parseJsonContent(plaintext) {
  // Parse the plaintext input into a JSON object
  var jsonContent = JSON.parse(plaintext);

  // Remove starter data
  for (const key in jsonContent.starterData) {
    if (jsonContent.starterData.hasOwnProperty(key)) {
      jsonContent.starterData[key]["$m"] = null;
    }
  }

  // Converts to Binary
  for (const key in jsonContent.dexData) {
    if (jsonContent.dexData.hasOwnProperty(key)) {
      jsonContent.dexData[key]["$sa"] = BigInt(jsonContent.dexData[key]["$sa"]).toString(2).padStart();
      jsonContent.dexData[key]["$ca"] = BigInt(jsonContent.dexData[key]["$ca"]).toString(2).padStart();
      jsonContent.dexData[key]["$na"] = BigInt(jsonContent.dexData[key]["$na"]).toString(2).padStart();
      jsonContent.dexData[key]["ribbons"] = parseInt(jsonContent.dexData[key]["ribbons"], 16).toString(2);
    }
  }
  return jsonContent;
}


function writeJsonToSheet(jsonContent) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('newJSON');
  var startRow = 1; // Starting at row 1

  // Convert JSON object to a formatted string
  const jsonString = formatJsonWithoutQuotes(jsonContent, 0);



  // Split the cleaned string into lines
  const jsonLines = jsonString.split('\n');

  // Prepare the array for setValues
  const values = jsonLines.map(line => [line.trim()]);

  // Set values in the sheet
  sheet.getRange(startRow, 1, values.length, 1).setValues(values);
}


function uploadFile(obj) {
  var blob = createBlob(obj);
  var plaintext = decryptFile(blob);
  var jsonContent = parseJsonContent(plaintext);
  writeJsonToSheet(jsonContent);
}
