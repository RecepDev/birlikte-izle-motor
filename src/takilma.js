// Stremio gerçekten takıldı mı (yeniden başlatmaya değer mi)? Yalnızca: izlenen torrent daha
// önce indiriyordu (1+ Mbps), bağlı kişi (peer) var ama hiç veri gelmiyor ve biri video ortasında
// bekliyor. Yeni açılan (henüz veri bulamamış) torrent takılma sayılmıyor: bekçi yeni bölümün
// ilk dakikasında Stremio'yu kapatıyordu. Ölü torrent'te (peer yok) yeniden başlatmak işe yaramıyor.
export function stremioTakildiMi(room, stats) {
  if (stats && stats.downMbps >= 1) room.hadSpeedFor = room.hostStreamId;
  const waiting = room.connectedUsers().some((u) => u.status?.state === 'buffering');
  const dead = Boolean(room.hadSpeedFor === room.hostStreamId && stats && stats.peers > 0
    && stats.downMbps < 0.05 && !(stats.progress >= 0.99));
  return waiting && dead;
}
