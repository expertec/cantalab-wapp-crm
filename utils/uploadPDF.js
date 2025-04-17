// server/utils/uploadPDF.js
import { getStorage, ref, uploadBytes, getDownloadURL } from "firebase-admin/storage";
import { admin } from "../firebaseAdmin.js";

export async function uploadPDFToStorage(filePath, destination) {
  const bucket = admin.storage().bucket();
  try {
    await bucket.upload(filePath, { destination });
    const file = bucket.file(destination);
    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: '03-01-2500' // Ajusta la fecha según tus necesidades
    });
    return url;
  } catch (err) {
    console.error("Error al subir el PDF:", err);
    return null;
  }
}
