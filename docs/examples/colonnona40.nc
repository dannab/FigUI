G17
G90
G21
M7
M8
(--- sgrezzatura ---)
G10 L20 P0 A0
G00 Z50.0000
X0 Y-4
g01 f500
z33
y415 z25 a160000 f2000
(ricaviamo un cilindro da 50 per misurare se la punta è a segno)
G10 L20 P0 A0
y405 a20000
(--)
z50 f1000
(--- Fine sgrezzatura---)
M5 M9
G10 L20 P0 A0
M30
