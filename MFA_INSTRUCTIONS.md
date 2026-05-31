Stappen om je Garmin sessie handmatig te importeren (MFA Bypass):

1.  Zorg dat je op je eigen browser (Chrome/Edge/Firefox) bent ingelogd op connect.garmin.com.
2.  De `@flow-js/garmin-connect` library verwacht drie specifieke JSON bestanden in de map:
    `velomate/backend/session/`

De bestanden die we nodig hebben zijn:
- `oauth1_token.json`
- `oauth2_token.json`
- `user_settings.json`

Omdat het lastig is om deze exact uit de browser-cookies te vissen, is er een makkelijkere manier:

### Methode: Gebruik een simpel scriptje om de tokens één keer op te halen
Ik heb de backend code al zo ingesteld dat hij de map `backend/session` gebruikt. 

Als je de bestanden nog niet hebt, kun je ze als volgt aanmaken (placeholder inhoud):

1. Maak een bestand `velomate/backend/session/oauth1_token.json` aan.
2. Maak een bestand `velomate/backend/session/oauth2_token.json` aan.
3. Maak een bestand `velomate/backend/session/user_settings.json` aan.

---
WACHTING: Omdat de library de tokens zelf genereert na een succesvolle login, is de beste manier om MFA te omzeilen als volgt:

1. Zet MFA **éénmalig** uit op garmin.com.
2. Log in via de Velomate app.
3. De app slaat de tokens op in `backend/session/`.
4. Zet MFA weer **AAN** op garmin.com.
5. De opgeslagen tokens blijven meestal 30 dagen geldig, dus de app blijft werken zonder dat je MFA code opnieuw nodig hebt.
