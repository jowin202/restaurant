import { Component, signal, ChangeDetectionStrategy } from '@angular/core';
import { AuthService } from '../../services/auth.services';
import { ApiService } from '../../services/api.service';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';
import { firstValueFrom } from 'rxjs';

@Component({
  selector: 'app-database-management',
  standalone: true,
  imports: [MatCardModule, MatButtonModule, MatProgressSpinnerModule, MatIconModule],
  templateUrl: './backup.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './backup.css'
})
export class DatabaseManagement {
  file: File | null = null;
  loading = signal(false);
  message = signal<string | null>(null);
  error = signal(false);

  constructor(private auth: AuthService, private api: ApiService) { }

  onFileSelected(event: any) {
    this.file = event.target.files?.[0] ?? null;
  }

  // --- BACKUP (Download) ---
  async downloadBackup() {
    this.loading.set(true);
    this.message.set(null);
    this.error.set(false);

    try {
      const response = await firstValueFrom(
        this.api.getFileStream('/api/admin/backup', this.auth.token())
      );

      // 1. Validierung: Hat der ApiService das Fehler-Array aus dem catchError geliefert?
      if (Array.isArray(response) && response[0]?.error_code) {
        throw new Error(response[0].error_string);
      }

      // 2. Extrahiere den Blob aus dem Body
      // WICHTIG: createObjectURL braucht response.body, nicht das ganze response Objekt!
      const blob = response.body;

      if (!blob || !(blob instanceof Blob)) {
        throw new Error('Keine gültigen Dateidaten (Blob) empfangen.');
      }

      // 3. Download-Prozess
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `boxertafel_backup_${new Date().toISOString().split('T')[0]}.sql`;

      document.body.appendChild(a); // Optional, aber sauberer für manche Browser
      a.click();

      // 4. Aufräumen
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);

      this.message.set('Backup erfolgreich heruntergeladen.');
    } catch (e) {
      console.error('Download-Fehler:', e);
      this.message.set('Fehler beim Erstellen des Backups.');
      this.error.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  // --- RESTORE (Upload) ---
  async restoreDatabase() {
    if (!this.file) return;

    // Sicherheitsabfrage
    if (!confirm('ACHTUNG: Dies wird die gesamte Datenbank löschen und überschreiben. Fortfahren?')) {
      return;
    }

    this.loading.set(true);
    this.message.set(null);
    this.error.set(false);

    // Wir nutzen FormData, um die Datei korrekt zu verpacken
    const formData = new FormData();
    formData.append('file', this.file); // Der Key 'file' muss exakt so im Backend stehen

    try {
      // Nutze die 'upload' Methode deines ApiServices (ohne manuellen JSON Content-Type)
      const response = await firstValueFrom(
        this.api.uploadBackup('/api/admin/restore', this.auth.token(), formData)
      );

      // Fehlerbehandlung analog zu deinem Service-Stil
      if (Array.isArray(response) && response[0]?.error_code) {
        throw new Error(response[0].error_string);
      }

      this.message.set('Datenbank erfolgreich wiederhergestellt!');
      this.file = null; // Reset
      this.error.set(false);
    } catch (e: any) {
      console.error('Restore Fehler:', e);
      this.message.set(e.message || 'Wiederherstellung fehlgeschlagen (HMAC ungültig?).');
      this.error.set(true);
    } finally {
      this.loading.set(false);
    }
  }
}