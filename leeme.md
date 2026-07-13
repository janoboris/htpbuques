# HTP — Control de Transferencia

Sistema rehecho para el muelle HTP (Huachipato Terminal Portuario, Grupo CAP), con
**3 perfiles** (Gerencia, Supervisor, Tarja) que ahora **se sincronizan en tiempo real
entre dispositivos distintos** (tablet en el muelle, PC de oficina, celular del
supervisor, etc.) usando una base de datos gratuita de Google (Firebase Firestore).

---

## 1. Qué cambió respecto a la versión anterior

- **Sincronización real entre dispositivos.** Antes cada navegador tenía sus propios
  datos (localStorage). Ahora todo vive en la nube y se actualiza solo, sin recargar.
- **Perfil Gerencia nuevo:** buques activos con KPIs, detalle completo (bodegas,
  detenciones, tiempos, KPIs) e histórico filtrable.
- **Flota de Camiones:** patente + tara vacía/llena quedan guardadas una sola vez;
  Tarja solo selecciona la patente de una lista.
- **Detenciones estructuradas:** inicio, fin, motivo y si afecta el rate — visibles
  para Supervisor y Gerencia, no solo un número suelto.
- **Cargar buques pasados** para armar histórico (dentro de "Crear / cargar buque").
- **Gestión completa del buque:** editar datos, ajustar tonelaje y tiempos, pausar por
  gira, reanudar, cerrar, reabrir y eliminar.
- **Aprobación de cierre de turno:** Tarja cierra, Supervisor aprueba o rechaza
  (si rechaza, el turno vuelve a quedar abierto para corregir).
- **Rate bruto vs. rate neto** calculados con el tiempo real transcurrido desde el
  inicio real del buque, descontando solo las detenciones marcadas como "afecta rate".
- **Bodegas por tipo individual** (carga o descarga), incluso en buques mixtos.
- **Paleta más suave para turnos largos** y un logo propio.
- **Exportar a CSV** (se abre directo en Excel) desde Supervisor y en cada buque.

## 2. Archivos incluidos

```
index.html          → login / selección de perfil (Gerencia, Supervisor, Tarja)
gerencia.html
supervisor.html
tarja.html
config.html          → redirección de compatibilidad (ya no se usa por separado)
htp-style.css         → estilos compartidos
htp-core.js            → lógica de datos y cálculos compartidos
firebase-config.js     → AQUÍ debes pegar tus datos de Firebase (ver paso 3)
```

Todos los archivos deben quedar en la **misma carpeta**.

## 3. Configurar la base de datos (una vez, ~10 minutos, gratis)

1. Ve a **https://console.firebase.google.com** e inicia sesión con una cuenta Google.
2. **Crear un proyecto** → ponle un nombre, por ejemplo `htp-terminal`. Puedes
   desactivar Google Analytics, no lo necesitas.
3. Dentro del proyecto, ve a **Compilación → Firestore Database → Crear base de
   datos**. Elige la ubicación más cercana (ej. `southamerica-east1`) y modo
   **producción**.
4. Ve a **Reglas** dentro de Firestore y reemplaza el contenido por esto (permite que
   la app lea y escriba sus propias 4 colecciones):

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /buques/{doc}      { allow read, write: if true; }
       match /turnos/{doc}      { allow read, write: if true; }
       match /camiones/{doc}    { allow read, write: if true; }
       match /detenciones/{doc} { allow read, write: if true; }
     }
   }
   ```
   Publica los cambios. (Esto deja la base abierta a quien tenga la URL de la app —
   suficiente para un sistema interno. Si más adelante quieres pedir clave de acceso,
   se puede agregar Firebase Authentication.)

5. Ve a **Configuración del proyecto** (ícono de engranaje) → baja hasta **Tus apps**
   → click en **`</>`** (Web) → dale un nombre y **Registrar app**. Te mostrará un
   bloque `firebaseConfig = {...}`.
6. Copia esos valores dentro de `firebase-config.js`, reemplazando los
   `"// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyAjEoIbvfhV1zG-XSF1lgWaKWMFop6oT9c",
  authDomain: "htp-control-carga.firebaseapp.com",
  projectId: "htp-control-carga",
  storageBucket: "htp-control-carga.firebasestorage.app",
  messagingSenderId: "510100368690",
  appId: "1:510100368690:web:c872147b03dfb859d2fb2b"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);"`.

Listo. Ese mismo `firebase-config.js` se usa en los 4 archivos HTML — todos los
dispositivos que abran estos archivos con ese archivo de configuración verán los
mismos datos, en vivo.

## 4. Cómo usarlo en el muelle

- **La forma más simple:** sube la carpeta completa a hosting gratuito (Firebase
  Hosting, Netlify o GitHub Pages) y entra desde cualquier dispositivo con esa URL.
  Con Firebase Hosting: instala `npm install -g firebase-tools`, luego
  `firebase login`, `firebase init hosting` (selecciona esta carpeta como público) y
  `firebase deploy`.
- **También funciona** abriendo `index.html` directamente en el navegador de cada
  dispositivo (doble clic), siempre que tengan internet y la misma carpeta con el
  `firebase-config.js` ya completado.
- Cada persona ingresa su nombre una vez por dispositivo (se guarda localmente, no es
  una contraseña) — sirve para saber quién registró cada dato.

## 5. Fuera de línea

Si se corta el internet en el muelle, Tarja puede seguir registrando: los datos se
guardan localmente y se sincronizan solos apenas vuelve la conexión. El indicador
"● en vivo / ● sin conexión" en la esquina superior avisa el estado.

## 6. Próximos pasos posibles

- Agregar clave/PIN por perfil con Firebase Authentication.
- Exportar histórico completo a un solo Excel con varias hojas.
- Notificaciones cuando un cierre de turno queda pendiente de aprobar.
