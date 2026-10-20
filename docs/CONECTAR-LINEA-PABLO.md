# Conectar la línea de Pablo (Kapso)

Pablo sigue usando su WhatsApp Business como siempre. El agente trabaja sobre
el mismo número y solo les habla a los números que **no** tiene agendados.

## Antes de empezar

- El PR de `feat/kapso-agenda` está mergeado a `main` y Railway despliega `main`.
- Pablo tiene la app de WhatsApp Business actualizada y el teléfono a mano (hay que escanear un QR).

## 1. Kapso: proyecto propio para Pablo

1. En Kapso, crear un proyecto nuevo (por ejemplo "Vacker - Pablo").
   Tiene que ser solo para su número: la agenda se lee de todos los contactos del proyecto.
2. **Connected numbers → Connect new number → WhatsApp Business App.**
3. Iniciar sesión con la cuenta de Facebook que administra el portfolio de Vacker.
4. Pablo escanea el QR desde **WhatsApp Business → Ajustes → Cuenta → Plataforma empresarial**.
5. Cuando lo pregunte, **aceptar compartir el historial de chats**. Es el segundo resguardo:
   si Meta no manda algún contacto de la agenda, igual sabemos que ya hablaban.
6. Esperar a que en Kapso aparezcan los contactos (WhatsApp → Contacts) y las conversaciones.
   Puede tardar unos minutos.
7. Crear una API key del proyecto y anotar el **phone_number_id** del número.

## 2. Railway: variables del servicio VackerAgent

| Variable | Valor |
| --- | --- |
| `WHATSAPP_PROVIDER` | `kapso` |
| `KAPSO_API_KEY` | la API key del paso 1.7 |
| `KAPSO_PHONE_NUMBER_ID` | el phone_number_id del paso 1.7 |
| `KAPSO_WEBHOOK_SECRET` | una clave larga inventada (la misma va en el paso 3) |
| `DB_PATH` | `/data/pablo.sqlite` (base nueva, sin las conversaciones de prueba) |
| `MODO_OBSERVACION` | borrarla o poner `true` |
| `PRUEBAS_REINICIAR` | **no tiene que existir** |

La base nueva importa: en la de pruebas, los números con los que se probó quedaron
como leads, y un lead sigue siendo lead aunque Pablo lo tenga agendado.

## 3. Kapso: webhook hacia el agente

En el número de Pablo, crear **un** webhook de tipo **Meta** (solo se permite uno por número):

- URL: `https://<dominio del servicio en Railway>/webhook`
- Secret: el mismo `KAPSO_WEBHOOK_SECRET`

## 4. Verificar

`GET /api/estado` con `Authorization: Bearer <ADMIN_TOKEN>` tiene que mostrar:

- `agenda.cargada: true` y una cantidad de contactos parecida a la agenda de Pablo
- `observacion: true`

En los logs de Railway: `[historial] N chats previos …` y `[agenda] N contactos cargados`.

Si la agenda dice 0 contactos o `cargada: false`, **no seguir**: el agente trataría a todos como leads
(o a nadie). Revisar la API key y que los contactos aparezcan en Kapso.

## 5. Semana de observación

El agente no responde: solo anota qué habría hecho. Revisar `GET /api/filtro`:

- Cada decisión `lead` trae el número: ¿son todos clientes de verdad?
- Las decisiones `personal` no traen número (no se guarda nada de familia y amigos).

Si en una semana no aparece ningún amigo o familiar como lead, poner `MODO_OBSERVACION=false`.

## Si algo sale mal

- Apagar al instante: `MODO_OBSERVACION=true` en Railway (o borrar la variable).
- Que el agente nunca le hable a un número: `POST /api/bloquear` con `{ "numero": "549..." }`.
- Pablo escribe en un chat del agente: el agente se corre de esa conversación para siempre.
