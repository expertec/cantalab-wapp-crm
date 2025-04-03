const dotenv = require('dotenv');
dotenv.config();
const { Configuration, OpenAIApi } = require('openai');

if (!process.env.OPENAI_API_KEY) {
  throw new Error("Falta la variable de entorno OPENAI_API_KEY");
}

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

/**
 * Genera un plan de ventas para Facebook en formato de texto plano,
 * personalizado según los datos del lead.
 *
 * @param {object} lead - Objeto con datos del lead.
 * @returns {Promise<string|null>} - El plan generado o null en caso de error.
 */
async function generarEstrategia(lead) {
  console.log("Datos del lead:", lead);

  const promptData = {
    businessName: lead.negocio || "Nombre no proporcionado",
    businessType: lead.giro || "General",
    description: lead.descripcion || "Descripción no proporcionada",
    contactName: lead.nombre || "Sin nombre de contacto",
    phone: lead.telefono || "Sin teléfono"
  };

  const prompt = `Genera un plan de ventas para Facebook personalizado para el negocio "${promptData.businessName}".
Utiliza la siguiente información:
  - Giro: ${promptData.businessType}
  - Descripción: ${promptData.description}
  - Contacto: ${promptData.contactName}
  - Teléfono: ${promptData.phone}

El plan debe estar en formato de texto plano y debe incluir las siguientes secciones numeradas:

1. Objetivos del plan: Define objetivos específicos adaptados a un negocio de "${promptData.businessType}" basado en "${promptData.description}".
2. Público objetivo: Describe de forma segmentada el público ideal para un negocio de "${promptData.businessType}".
3. Estrategias de marketing en Facebook: Desarrolla estrategias concretas que se ajusten a un negocio de "${promptData.businessType}" y basadas en "${promptData.description}".
4. Calendario de contenidos (15 días): Para cada día, en la sección "Contenido Orgánico" especifica:
     - Si se utilizará una imagen o un video (y si el video debe ser tipo reel).
     - El estilo de diseño y un copy sugerido con estrategias VSL adaptadas a "${promptData.businessType}" y "${promptData.description}".
   En la sección "Anuncio", describe un ejemplo de campaña, por ejemplo:
     "Dirige una campaña de retargeting a usuarios que hayan interactuado con publicaciones anteriores, utilizando un video corto y un CTA 'Conocer Más', adaptado a este negocio."
5. Presupuesto y KPIs: Define un presupuesto y KPIs relevantes para un negocio de "${promptData.businessType}".
6. Herramientas e integración: Menciona herramientas específicas para optimizar la estrategia en el sector de "${promptData.businessType}".

Genera el plan completo en texto plano, con secciones claras y numeradas, personalizando cada sección basándote en la información proporcionada.`;

  console.log("Prompt enviado a ChatGPT:", prompt);

  try {
    const response = await openai.createChatCompletion({
      model: "gpt-4",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
    });
    const plan = response.data.choices[0].message.content;
    console.log("Respuesta de ChatGPT:", plan);
    return plan;
  } catch (error) {
    console.error("Error al llamar a ChatGPT:", error.response ? error.response.data : error);
    return null;
  }
}

module.exports = {
  generarEstrategia
};
