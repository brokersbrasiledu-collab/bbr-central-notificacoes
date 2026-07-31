/**
 * Datas no fuso de São Paulo.
 *
 * O banco grava tudo em UTC (datetime('now')), mas "hoje" para quem usa o
 * app é o dia no relógio de Brasília. Às 21h de um dia aqui já é o dia
 * seguinte em UTC — filtrar por data sem essa conversão mostraria a lista
 * errada durante três horas por dia.
 */

const FUSO = 'America/Sao_Paulo';

/**
 * Deslocamento do fuso em horas, lido do próprio sistema.
 *
 * O Brasil não usa mais horário de verão desde 2019, então na prática é
 * sempre -3. Ainda assim, perguntar é mais seguro do que fixar o número:
 * se a regra voltar a mudar, o cálculo acompanha.
 */
function deslocamentoHoras(data = new Date()) {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: FUSO,
    timeZoneName: 'shortOffset',
  }).formatToParts(data);

  const nome = partes.find((p) => p.type === 'timeZoneName')?.value || 'GMT-3';
  const achado = nome.match(/GMT([+-]\d{1,2})(?::(\d{2}))?/);
  if (!achado) return -3;

  const horas = Number(achado[1]);
  const minutos = Number(achado[2] || 0) / 60;
  return horas + (horas < 0 ? -minutos : minutos);
}

/** Data de hoje em São Paulo, no formato AAAA-MM-DD. */
export function hojeEmSaoPaulo() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * Instante UTC correspondente à meia-noite de N dias atrás em São Paulo,
 * no formato que o SQLite usa ("AAAA-MM-DD HH:MM:SS").
 *
 * @param {number} diasAtras 0 = hoje, 7 = uma semana atrás
 */
export function inicioDoDiaUTC(diasAtras = 0) {
  const [ano, mes, dia] = hojeEmSaoPaulo().split('-').map(Number);

  // Meia-noite local convertida para UTC: somar o deslocamento invertido.
  const desloc = deslocamentoHoras();
  const instante = Date.UTC(ano, mes - 1, dia - diasAtras, 0, 0, 0) - desloc * 3600 * 1000;

  return new Date(instante).toISOString().slice(0, 19).replace('T', ' ');
}
