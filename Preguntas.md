# Laboratorio de Observabilidad — Grafana, Prometheus y Loki

**Curso:** Infraestructura como Código
**Entorno de ejecución:** Windows con WSL2 (Docker Engine nativo)

Este documento recoge todos los pasos que realicé para completar el laboratorio, las adaptaciones necesarias para ejecutarlo en Windows, las respuestas a las preguntas y las instrucciones para validar el trabajo.

---

## Adaptaciones para Windows / WSL2

### Cambio 1 — Volumen de `node-exporter` (`rslave` → `ro`)

`rslave` solo aplica en Linux nativo. En Windows con Docker Desktop (WSL2), el montaje raíz no tiene esa propagación, así que `node-exporter` fallaba y no levantaban los 8 contenedores. Por eso eliminé la opción `rslave` y dejé solo `ro`.

**Antes:**

```yaml
volumes:
  - /:/host:ro,rslave
```

**Después:**

```yaml
volumes:
  - /:/host:ro
```

### Cambio 2 — Migración a Docker Engine nativo en WSL

Al ejecutar la consulta en Prometheus me aparecía **"Empty query result"**. Comprobé que cAdvisor no estaba generando la etiqueta `name` por contenedor individual.

La causa: Docker Desktop con WSL2 ejecuta los contenedores dentro de una VM aislada de Windows llamada `docker-desktop`. cAdvisor, que corre en mi distro de WSL, no podía acceder a las capas de los contenedores, porque viven dentro de esa VM separada e inaccesible.

**Solución:** la forma definitiva de hacer funcionar cAdvisor correctamente fue reemplazar Docker Desktop por Docker Engine nativo dentro de WSL.

---

## Paso 1 — Levantar el stack

### 1. Instalar Docker Engine en WSL

Desde la terminal de WSL ejecuté:

```bash
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER
sudo service docker start
```

### 2. Verificar la instalación

```bash
docker --version
docker compose version
```

### 3. Cambiar el storage driver a overlay2

El Docker recién instalado usaba `overlayfs`, pero cAdvisor v0.49.1 necesita `overlay2`. Creé el archivo de configuración:

```bash
sudo nano /etc/docker/daemon.json
```

Con el siguiente contenido:

```json
{
  "storage-driver": "overlay2"
}
```

Y reinicié Docker:

```bash
sudo service docker restart
```

### 4. Levantar el stack desde WSL

Desde la carpeta del proyecto:

```bash
docker compose up -d --build
```

Espera a que todos los contenedores estén arriba (la primera vez tarda más porque construye las apps y descarga imágenes). Verifica el estado:

```bash
docker compose ps
```

### 5. Verificar los contenedores

```bash
docker ps
```

Deben aparecer los **8 contenedores** activos: `lab-backend`, `lab-frontend`, `lab-prometheus`, `lab-grafana`, `lab-loki`, `lab-alloy`, `lab-cadvisor` y `lab-node-exporter`.

### 6. Validar la solución en Prometheus

Esperé a que cAdvisor empezara a recolectar métricas, entré a <http://localhost:9090> y ejecuté:

```promql
container_cpu_usage_seconds_total{name="lab-backend"}
```

Al devolver la serie con `name="lab-backend"`, confirmé que la migración funcionó.

### Servicios principales

Comprobé en el navegador que responden los servicios principales:

| Servicio   | URL                            | Qué debería ver                          |
|------------|--------------------------------|------------------------------------------|
| Frontend   | <http://localhost:8080>          | Página "Hello World" con dos botones     |
| Backend    | <http://localhost:3001/metrics>  | Texto de métricas en formato Prometheus  |
| Grafana    | <http://localhost:3000>          | Login (usuario `admin`, clave `admin`)   |
| Prometheus | <http://localhost:9090>          | Interfaz de Prometheus                   |

---

## Paso 2 — Generar tráfico y logs

Para tener datos que observar:

- Abre el frontend en <http://localhost:8080>.
- Pulsa varias veces el botón **"Saludar (API)"**. Cada pulsación genera una petición al backend, una métrica y varias líneas de log.
- Deja la pestaña abierta unos minutos: las apps también emiten logs simulados de actividad (pedidos, pagos, advertencias y errores) de forma periódica.

El botón de carga de CPU lo usaremos al probar la alarma.

---

## Paso 3 — Verificar las fuentes de datos en Grafana

Las fuentes de datos ya están aprovisionadas como código, así que no hay que crearlas a mano.

- Entra a Grafana (<http://localhost:3000>) con `admin` / `admin`.
- Ve a **Connections → Data sources**.
- Confirma que existen **Prometheus** y **Loki**, ambos en estado correcto (puedes usar el botón *Test* / *Save & test*).

---

## Paso 4 — Construir el dashboard

Crea un nuevo dashboard: **Dashboards → New → New dashboard → Add visualization**.

### 4.1 Panel: CPU del contenedor de la aplicación

- Selecciona la fuente de datos **Prometheus**.
- En el editor de consulta, escribe esta expresión PromQL:

```promql
sum(rate(container_cpu_usage_seconds_total{name="lab-backend"}[1m])) * 100
```

- Devuelve el % de CPU que consume el contenedor del backend (100 ≈ un núcleo completo).
- Tipo de visualización: **Time series**.
- En **Standard options → Unit**, elige **Percent (0–100)**.
- (Recomendado) En **Thresholds**, añade un umbral en `50` con color rojo: así verás visualmente cuándo se cruza el límite.
- Título del panel: **"CPU contenedor backend (%)"**. Guarda con **Apply**.

### 4.2 Panel: CPU del host (infraestructura)

Crea otro panel con fuente **Prometheus** y la consulta:

```promql
100 - (avg(rate(node_cpu_seconds_total{mode="idle"}[1m])) * 100)
```

Unidad **Percent (0–100)**, título **"CPU del host (%)"**. Este panel representa la métrica de infraestructura general (la máquina), frente al panel anterior que es por contenedor.

### 4.3 Panel: Logs de aplicación (API + frontend)

- Crea un panel nuevo y selecciona la fuente **Loki**.
- Cambia el tipo de visualización a **Logs**.
- En el editor, usa el filtro por etiqueta:

```logql
{tier="application"} | json
```

- `tier="application"` trae solo los logs del backend y del frontend.
- `| json` parsea los campos del log (level, service, msg, etc.) para poder filtrarlos.
- Prueba a filtrar por nivel; por ejemplo, solo errores:

```logql
{tier="application"} | json | level="ERROR"
```

- Título: **"Logs de aplicación (API + frontend)"**.

### 4.4 Panel: Logs de infraestructura

Repite con fuente **Loki**, tipo **Logs**, y la consulta:

```logql
{tier="infrastructure"}
```

Esto muestra los logs de los componentes del stack (Prometheus, Loki, Grafana, exporters…). Título: **"Logs de infraestructura"**.

---

## Paso 5 — Configurar la alarma de CPU > 50%

Usaremos las alarmas de Grafana (Grafana Alerting).

- Ve a **Alerting → Alert rules → New alert rule**.
- Nombre: `CPU backend > 50%`.
- **Define query and alert condition** — Query A, fuente Prometheus:

```promql
sum(rate(container_cpu_usage_seconds_total{name="lab-backend"}[1m])) * 100
```

- En la sección de condición, Grafana añade por defecto una expresión **Reduce** (función `Last`) y una expresión **Threshold**. En el Threshold, configura **IS ABOVE `50`**. Esa es la condición de alerta.
- **Evaluation behavior:** crea (o elige) una carpeta y un *evaluation group* con intervalo de evaluación de `10s`.
- **Pending period:** `30s` (la métrica debe mantenerse sobre 50% durante 30s antes de pasar a *Firing*; evita falsas alarmas por picos cortos).
- **Configure labels and notifications:** añade una etiqueta `severity = warning`.
- Guarda con **Save rule and exit**.

---

## Paso 6 — Probar la alarma

- En el frontend (<http://localhost:8080>) pulsa **"Generar carga de CPU (30s)"**. Alternativa por terminal:

```bash
curl "http://localhost:3001/load?seconds=60"
```

- Observa el panel de CPU del backend: debe subir y superar el 50%.
- Ve a **Alerting → Alert rules** y observa cómo la regla pasa de `Normal → Pending → Firing`.
- Cuando termina la carga, la métrica baja y la alarma vuelve a `Normal`.

Toma una captura del estado **Firing** y del panel con la CPU por encima de 50%: es parte del entregable.

---

## Paso 7 — Cerrar el ciclo: alarma → log (vía Webhook)

El objetivo de este paso es completar el recorrido de la observabilidad. Creamos un canal de tipo **Webhook** que apunta a `http://backend:3001/alerts`, de modo que cada vez que la alarma se active, el backend reciba ese aviso y deje registrada una línea de log. Ese log volverá a aparecer en el panel **"Logs de infraestructura"**, cerrando el flujo completo: una métrica supera el umbral, eso genera una alarma, la alarma provoca un log y ese log queda visible en el dashboard.

### Parte 1 — Crear el punto de contacto (Webhook)

1. En el menú lateral, abre **Alerting** y entra en **Contact points**.
2. Pulsa **Add contact point** (arriba a la derecha) y completa:
   - **Name:** un nombre que lo identifique (por ejemplo, `Backend_Webhook`).
   - **Integration:** elige **Webhook** en el desplegable.
   - **URL:** escribe la dirección interna de Docker exactamente así: `http://backend:3001/alerts`.
   - **HTTP Method:** verifica que esté en **POST**.
3. Usa el botón **Test** para mandar una alerta de prueba al backend y comprobar que responde. Luego pulsa **Save contact point**.

### Parte 2 — Enrutar las alertas hacia ese Webhook

1. Ve a **Alerting → Notification policies**.
2. Localiza la política principal (**Default / Root policy**) y pulsa **Edit**.
3. En **Default contact point**, selecciona el que acabas de crear (`Backend_Webhook`) y guarda los cambios.
4. Confirma que la propia regla de alerta tenga asignado ese contacto en su apartado **Configure notifications**.

### Resultados

En los **logs de la aplicación** llegó la alerta. Filtrando las peticiones POST que recibió el backend:

```logql
{tier="application"} | json | method = "POST"
```

En los **logs de infraestructura** también se puede verificar que llegaron logs de alerta:

```logql
{tier="infrastructure"} |= "alert"
```

---

## Breve explicación de cada componente del stack (5–8 líneas)

El stack se compone de 8 servicios que trabajan en conjunto. El **backend** y el **frontend** son las aplicaciones del laboratorio: generan tráfico, exponen sus métricas en `/metrics` y escriben logs. **Prometheus** es la base de datos de métricas: recolecta y almacena los valores numéricos en el tiempo. Para alimentarlo, **node-exporter** aporta las métricas del host y **cAdvisor** las de los contenedores. Por el lado de los logs, **Loki** los almacena y **Grafana Alloy** es el recolector que toma los logs de cada contenedor y los envía a Loki. Finalmente, **Grafana** es la capa de visualización: se conecta a Prometheus y a Loki, dibuja los dashboards y gestiona las alarmas.

---

## Preguntas a responder

### 1. ¿Por qué necesitamos Loki además de Prometheus si ya tenemos /metrics?

Porque son dos señales distintas. Prometheus solo maneja **métricas**: números en el tiempo (CPU, memoria, peticiones por segundo), que es lo que expone /metrics. Los **logs** son texto (eventos, errores, trazas) y Prometheus no está diseñado para almacenarlos ni consultarlos. Loki es la base de datos de logs. En la práctica se complementan: las métricas te dicen **que** algo va mal (la CPU subió), y los logs te dicen **por qué** (el error o evento concreto que lo causó).

### 2. ¿Qué ventaja aporta que las fuentes de datos de Grafana estén aprovisionadas como código y no creadas a mano?

Reproducibilidad y consistencia. Al definirse en archivos de provisioning versionables, cualquiera que levante el stack obtiene las mismas fuentes configuradas automáticamente, sin depender de que alguien recuerde hacer clic ni cometa errores manuales. La configuración se versiona en Git, se revisa y se replica en otros entornos de forma idéntica. Es el principio de Infraestructura como Código: configuración declarativa, repetible y auditable.

### 3. El panel "CPU contenedor" y el panel "CPU host" pueden mostrar valores muy distintos. ¿Por qué? ¿Cuál usarías para alertar sobre una aplicación concreta?

Porque miden cosas diferentes. "CPU host" es la CPU de **toda la máquina** (todos los procesos del sistema y todos los contenedores juntos). "CPU contenedor" es solo lo que consume **ese contenedor** en particular. Por eso pueden diferir mucho: el host suma todo, el contenedor es una porción. Para alertar sobre una **aplicación concreta** usaría la métrica del contenedor, porque aísla el consumo de esa app sin el ruido del resto del sistema.

### 4. ¿Qué diferencia hay entre el *evaluation interval* y el *pending period* de una alarma?

El **evaluation interval** es cada cuánto Grafana ejecuta la consulta de la alarma para revisar si se cumple la condición (por ejemplo, cada 10s). El **pending period** es cuánto tiempo debe mantenerse cumplida esa condición antes de que la alarma pase de *Pending* a *Firing*. El primero es la **frecuencia de chequeo**; el segundo es un **colchón** que evita falsas alarmas por picos cortos.

---

## Comandos útiles

```bash
docker compose up -d --build     # levantar / reconstruir
docker compose ps                # estado de los servicios
docker compose logs -f grafana   # seguir logs de un servicio
docker compose down              # detener (conserva dashboards)
docker compose down -v           # detener y borrar todos los datos
```
