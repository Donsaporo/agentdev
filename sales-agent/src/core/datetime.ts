const TIMEZONE = 'America/Panama';

export function getPanamaDateTime(): string {
  const now = new Date();

  const dateStr = now.toLocaleDateString('es-PA', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: TIMEZONE,
  });

  const timeStr = now.toLocaleTimeString('es-PA', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: TIMEZONE,
  });

  return `Hoy es ${dateStr}, ${timeStr} (hora de Panama)`;
}
