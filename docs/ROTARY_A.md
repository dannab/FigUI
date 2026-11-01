# FigUI: visualizzatore asse A — prima versione

Base originale: `figamore/FigUI`, commit `890e320ffae09fb4e91358d87a5ce3784efef555`.
Ramo locale: `feature/rotary-a-viewer`.

Questa versione estende FigUI mantenendo il parser incrementale, gli array compatti,
il motore WebGL e i servizi originali di comunicazione. Non introduce un nuovo
motore di controllo macchina. L'interfaccia generale di FigUI non è stata ancora
semplificata: questo cambiamento riguarda il visualizzatore e può essere proposto
separatamente al progetto originale.

## Uso

1. Caricare un G-code locale o un file del controller come in FigUI originale.
2. La presenza di parole A apre automaticamente la vista **A rotativo**.
   Lo stesso pulsante permette di tornare alla vista XYZ originale.
3. Scegliere **Parallelo a X** o **Parallelo a Y** secondo la macchina.
4. Con Z0 sul centro, mantenere **Centro Z = 0**. Anche il centro trasversale
   rimane 0 se lo zero dell'asse perpendicolare coincide con il centro del rotativo.
5. Se la convenzione angolare della macchina è opposta, attivare **Inverti verso A**.
6. Trascinare per orbitare, usare la rotella per lo zoom e Maiusc + trascinamento
   per spostare la vista. **Adatta** ripristina l'inquadratura.
7. Il cursore scorre il percorso. **Riproduci** lo percorre a velocità dimostrativa:
   un giro completo del cursore richiede circa 30 secondi, indipendentemente dal feed.

Orientamento, centro e verso sono salvati nel browser per indirizzo del controller.
Un asse lineare fermo a zero rimane fermo; il visualizzatore non modifica né limita
i movimenti scritti nel programma.

## Cosa rappresenta

Il pezzo è mostrato fermo. La traiettoria dell'utensile viene trasformata con la
rotazione inversa della tavola: si vedono così eliche, circonferenze e passate
avvolte. È una visualizzazione del percorso, senza simulazione dell'asportazione.
Non viene inventato un cilindro pieno o un diametro grezzo non indicato nel file.

A rimane espresso in gradi anche con G20. Sono conservati i giri completi,
i movimenti di sola A, G90/G91, i cambi zero G92 e G10 L2/L20, gli offset WCS,
G53 e l'interpolazione simultanea con XYZ e archi G17/G18/G19.
La geometria è campionata con un passo angolare massimo di 5 gradi. Per percorsi
superiori a un milione di tratti compare un messaggio, senza ridurre silenziosamente
i giri o bloccare il browser con un'allocazione illimitata.

Il programma di esempio `docs/examples/colonnona40.nc` produce 6 movimenti:
la prima passata avanza da Y-4 a Y415 e ruota di 160.000 gradi;
`G10 L20 P0 A0` cambia il riferimento senza muovere;
la passata successiva aggiunge 20.000 gradi, arrivando a 180.000 gradi fisici.

## Seguire la macchina

**Segui macchina** usa XYZ e A delle posizioni macchina, riportate nel riferimento
salvato al caricamento del file. Gli azzeramenti successivi non fanno saltare la
traiettoria. A viene confrontato senza modulo 360, per distinguere giri ripetuti.
Il valore A mostrato durante la lavorazione è la coordinata di lavoro corrente.

Se il report non contiene A o la posizione non corrisponde al percorso caricato,
la vista indica **Posizione macchina non agganciata** e nasconde il marcatore.
I programmi aperti da una macchina già in movimento devono avere il corretto
riferimento iniziale; il ripristino dalla cache conserva quello salvato. Il
tracciamento con report reali deve ancora essere collaudato sulle due macchine.

Il parser originale assume XYZ e A iniziali a zero: programmi che dipendono da una
posizione iniziale non esplicitata devono essere verificati con tale limite.
Eventuali assi B/C e trasformazioni cinematiche aggiuntive non sono visualizzati.

La stima tempi originale considera soltanto XYZ: per programmi con A non viene
mostrata. Anche la funzione di inquadramento automatico XYZ (Frame) e la vecchia
simulazione a tempo sono escluse dai programmi A; la riproduzione rotativa è
disponibile nella nuova vista. Controlli di esecuzione, file, terminale, jog e
connessione rimangono quelli originali.

## Sviluppo e fork

La copia locale deriva dalla storia Git originale. Per pubblicarla nel proprio
account, creare un fork di <https://github.com/figamore/FigUI/fork>, poi collegare
quel repository come `origin` mantenendo l'originale come `upstream`.
Il fork remoto non è stato creato da questo lavoro.

Tenere la futura semplificazione personale in un ramo separato dal visualizzatore:
questo permette di proporre al progetto originale soltanto il supporto A.
La licenza originale GPLv3 e le attribuzioni sono conservate nel pacchetto.

```text
npm ci
npm run build
npm test
```

Il test specifico è `scripts/test-gcode-rotary.ts`, incluso nel runner generale.
Per una prova locale senza CNC usare `npm run dev -- --mode demo --host 127.0.0.1`.
La versione demo usa il simulatore originale di FigUI e non si collega alle CNC.
