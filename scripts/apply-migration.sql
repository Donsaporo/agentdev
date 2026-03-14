/*
  # Insert Knowledge Articles & Create Director Pending Notifications Table

  Run this SQL in the Supabase SQL Editor (Dashboard > SQL Editor)

  1. New Knowledge Articles (sales_agent_knowledge)
    - "Portafolio - Paginas Web" - 8 case studies with URLs
    - "Portafolio - CRMs y Sistemas" - CRM for Bufete Duman & Co
    - "Portafolio - Chatbots y Agentes IA" - WhatsApp bots, TikTok, Instagram agents
    - "Rango Minimo de Precios - Paginas Web" - $275-300 minimum
    - "Diferenciacion vs Competencia" - Custom code, no CMS, not a marketing agency
    - "Tiempos Tipicos de Entrega" - Delivery timelines per project type
    - "Servicios Completos de Obzide" - Full service catalog

  2. New Tables
    - `director_pending_notifications` - Queue for notifications when director 24h window is closed

  3. Security
    - RLS enabled on director_pending_notifications
    - Policies for authenticated users
*/

-- ============================================================
-- KNOWLEDGE ARTICLES
-- ============================================================

INSERT INTO sales_agent_knowledge (category, title, content, source)
VALUES (
  'portafolio',
  'Portafolio - Paginas Web',
  'Obzide ha desarrollado multiples sitios web para clientes en distintas industrias. Algunos de nuestros casos de exito:

1. Jay Arias Tours (jayariastours.com) - Sitio web para empresa de turismo
2. Suproser (suproser.com) - Sitio web corporativo
3. Santa Marta Panama (santamartapanama.com) - Sitio web para proyecto inmobiliario/comunidad
4. Bufete DCO (bufetedco.com) - Sitio web para bufete de abogados
5. Urbanizacion Milla de Oro (urbmilladeoro.com) - Sitio web para proyecto inmobiliario
6. Tridentis Global (tridentisglobal.com) - Sitio web corporativo internacional
7. Obzide (obzide.com) - Nuestro propio sitio web corporativo
8. Obzide Links (links.obzide.com) - Plataforma de enlaces de Obzide

Todos estos sitios fueron desarrollados 100% en codigo personalizado, sin usar WordPress, Wix ni ningun CMS. Cada uno fue disenado y programado a medida para las necesidades especificas de cada cliente.',
  'director'
);

INSERT INTO sales_agent_knowledge (category, title, content, source)
VALUES (
  'portafolio',
  'Portafolio - CRMs y Sistemas',
  'Obzide ha desarrollado sistemas CRM personalizados para empresas:

1. CRM para Bufete Duman & Co - Sistema de gestion de clientes y casos legales desarrollado a medida para el bufete de abogados.

Ademas de CRMs, desarrollamos aplicaciones web y moviles, sistemas de automatizacion, y plataformas completas de gestion empresarial. Todos nuestros sistemas son desarrollados en codigo personalizado, sin depender de plataformas prearmadas.

El catalogo completo con capturas de pantalla y demos esta en proceso de armado.',
  'director'
);

INSERT INTO sales_agent_knowledge (category, title, content, source)
VALUES (
  'portafolio',
  'Portafolio - Chatbots y Agentes IA',
  'Obzide desarrolla soluciones avanzadas de inteligencia artificial:

- Chatbots inteligentes con IA conectados a WhatsApp
- Agentes de ventas autonomos con IA (como el sistema que opera este chat)
- Respuestas automatizadas en TikTok con IA
- Agentes de atencion en Instagram con IA
- Desarrollo de agentes de IA para cualquier plataforma o necesidad
- Automatizaciones inteligentes para procesos de negocio

Todo el desarrollo es personalizado y adaptado a las necesidades de cada cliente. No usamos herramientas de terceros prearmadas, sino que creamos soluciones propias con la tecnologia mas avanzada.',
  'director'
);

INSERT INTO sales_agent_knowledge (category, title, content, source)
VALUES (
  'precios',
  'Rango Minimo de Precios - Paginas Web',
  'El rango minimo de precios que se puede compartir es UNICAMENTE para paginas web:

- Pagina web: desde $275 - $300 USD (este es el minimo absoluto, lo mas basico)

IMPORTANTE: Este es el UNICO rango de precios que puedes mencionar. Para cualquier otro tipo de proyecto (CRM, aplicaciones, e-commerce, chatbots, etc.), NO des precios. En su lugar, propone agendar una reunion para que el equipo pueda preparar una cotizacion personalizada segun las necesidades del cliente.

Si el cliente insiste en saber precios de otros servicios, responde algo como: "El precio depende mucho del alcance y las funcionalidades que necesites. Lo ideal es que conversemos en una reunion rapida para entender bien tu proyecto y poder darte una cotizacion precisa."',
  'director'
);

INSERT INTO sales_agent_knowledge (category, title, content, source)
VALUES (
  'empresa',
  'Diferenciacion vs Competencia',
  'Obzide NO es una agencia de marketing ni una empresa de diseno web generica. Es una EMPRESA DE DESARROLLO DE SOFTWARE PERSONALIZADO.

La diferenciacion clave:
- No usamos ningun CMS (WordPress, Wix, Squarespace, Webflow, etc.)
- No usamos plantillas prearmadas ni temas comprados
- El 90% de los "programadores" en Panama usan CMS y plantillas. Nosotros NO.
- Todo nuestro trabajo es en CODIGO puro, artesanal, hecho a mano
- Cada proyecto es 100% personalizado y a medida para el cliente
- Somos programadores reales que escriben cada linea de codigo

Cuando un cliente mencione que esta viendo otras agencias u opciones, recalcar esta diferenciacion: no somos una agencia, somos desarrolladores de software que hacen todo desde cero, lo que significa mayor calidad, mejor rendimiento, y total flexibilidad para personalizar cualquier aspecto del proyecto.',
  'director'
);

INSERT INTO sales_agent_knowledge (category, title, content, source)
VALUES (
  'operaciones',
  'Tiempos Tipicos de Entrega',
  'Tiempos tipicos de entrega por tipo de proyecto:

- Pagina web normal: 10 a 14 dias
- E-commerce (tienda en linea): 10 a 25 dias
- CRM (sistema de gestion): 21 a 30 dias
- Aplicacion movil o web app: 30 a 60 dias (puede llegar a 90 dias dependiendo del alcance)

NOTA: Estos son tiempos aproximados y dependen del alcance del proyecto, la complejidad de las funcionalidades, y la velocidad de retroalimentacion del cliente. Siempre se recomienda discutir plazos especificos en la reunion de propuesta.

Si el cliente pregunta por tiempos, puedes compartir estos rangos como referencia general, pero aclara que el tiempo exacto se define una vez que se entiende el alcance completo del proyecto en la reunion.',
  'director'
);

INSERT INTO sales_agent_knowledge (category, title, content, source)
VALUES (
  'empresa',
  'Servicios Completos de Obzide',
  'Obzide Tech ofrece los siguientes servicios de desarrollo de software:

1. Paginas Web - Sitios corporativos, landing pages, portafolios (desde $275 USD)
2. E-commerce - Tiendas en linea con catalogo, carrito, pagos
3. CRMs - Sistemas de gestion de clientes personalizados
4. Aplicaciones Web - Plataformas, dashboards, sistemas internos
5. Aplicaciones Moviles - Apps para iOS y Android
6. Chatbots con IA - Bots inteligentes para WhatsApp, Instagram, TikTok
7. Agentes de IA - Agentes autonomos para ventas, atencion al cliente, etc.
8. Automatizaciones - Flujos automatizados para procesos de negocio
9. Desarrollo de Software a medida - Cualquier solucion tecnologica personalizada

Todos los servicios se desarrollan en codigo personalizado, sin CMS ni plantillas.
Sede: Panama (PH Plaza Real, Costa del Este)
Web: obzide.com',
  'director'
);

-- ============================================================
-- TABLE: director_pending_notifications
-- ============================================================

CREATE TABLE IF NOT EXISTS director_pending_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  director_phone text NOT NULL,
  notification_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

ALTER TABLE director_pending_notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view pending notifications"
  ON director_pending_notifications FOR SELECT
  TO authenticated
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can insert pending notifications"
  ON director_pending_notifications FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can update pending notifications"
  ON director_pending_notifications FOR UPDATE
  TO authenticated
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can delete pending notifications"
  ON director_pending_notifications FOR DELETE
  TO authenticated
  USING (auth.uid() IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_director_pending_status
  ON director_pending_notifications(status)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_director_pending_phone
  ON director_pending_notifications(director_phone, status);
