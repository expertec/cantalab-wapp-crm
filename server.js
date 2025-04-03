const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

// Ruta principal
app.get('/', (req, res) => {
  res.send('¡Hola, Render! Tu aplicación básica funciona.');
});

app.listen(port, () => {
  console.log(`Servidor escuchando en el puerto ${port}`);
});
