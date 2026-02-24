import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component } from '@angular/core';
import { MatChipsModule } from '@angular/material/chips';
import { MatIconModule } from '@angular/material/icon';
import { MatTableModule } from '@angular/material/table';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.services';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { UserDialog } from '../user-dialog/user-dialog';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';


export interface User {
  id: number;
  username: string;
  name: string;
  mail: string;
  admin: number;
}

interface BulkCreatedUser {
  id: number;
  name: string;
  username: string;
  login_link: string;
  print_status: string;
  print_error?: string;
}

interface BulkImportResponse {
  status: string;
  created_count: number;
  line_count: number;
  printer_ip?: string | null;
  warnings: string[];
  users: BulkCreatedUser[];
}

@Component({
  selector: 'app-user-table',
  imports: [
    CommonModule,
    MatTableModule,
    MatIconModule,
    MatChipsModule,
    MatButtonModule,
    MatTooltipModule,
    MatFormFieldModule,
    MatInputModule,
  ],
  templateUrl: './user-table.html',
  styleUrl: './user-table.css',
})
export class UserTable {
  users: User[] = [];
  displayedColumns: string[] = ['id', 'username', 'name', 'mail', 'role', 'actions'];
  bulkLines = '';
  bulkLoading = false;
  bulkResult: BulkImportResponse | null = null;

  constructor(
    private api: ApiService,
    public auth: AuthService, // public für Zugriff im Template
    private snackBar: MatSnackBar,
    private dialog: MatDialog,
    private cdr: ChangeDetectorRef
  ) { }

  ngOnInit(): void {
    this.loadUsers();
  }

  /**
   * Prüft die Hierarchie: 
   * Ein Admin darf nur User verwalten, deren Level NIEDRIGER ist als das eigene.
   */
  canAction(targetUser: User): boolean {
    const myLevel = this.auth.admin_level();
    // Falls admin_level() null oder undefined ist (nicht eingeloggt)
    if (myLevel === null || myLevel === undefined) return false;
    
    return myLevel > targetUser.admin;
  }

  canUserLinkActions(targetUser: User): boolean {
    return this.canAction(targetUser) && targetUser.admin === 0;
  }

  loadUsers(): void {
    this.api.get("/api/users/", this.auth.token()).subscribe({
      next: (data) => {
        this.users = data;
        this.cdr.detectChanges();
      },
      error: (err) => console.error(err)
    });
  }

  deleteUser(user: User): void {
    if (!this.canAction(user)) {
      this.snackBar.open('Unzureichende Rechte: Dein Level ist nicht hoch genug!', 'Schließen', {
        duration: 3000
      });
      return;
    }

    if (confirm(`Soll Benutzer ${user.username} wirklich gelöscht werden?`)) {
      this.api.delete("/api/users/" + user.id + "/", this.auth.token()).subscribe({
        next: () => {
          this.snackBar.open('Benutzer erfolgreich gelöscht', 'OK', { duration: 2000 });
          this.loadUsers();
        },
        error: (err) => {
          const msg = err.error?.detail || 'Server-Fehler beim Löschen';
          this.snackBar.open(msg, 'OK', { duration: 3000 });
        }
      });
    }
  }

  addUser(): void {
    const dialogRef = this.dialog.open(UserDialog, {
      width: '400px',
      // Wir geben das eigene Level mit, damit der Dialog die Auswahl einschränken kann
      data: { 
        username: '', name: '', mail: '', password: '', 
        admin: 0, maxLevel: this.auth.admin_level() 
      }
    });

    dialogRef.afterClosed().subscribe(result => {
      if (result) {
        // Das result.admin kommt hier idealerweise bereits als korrekter Integer an
        this.api.post("/api/users/", this.auth.token(), result).subscribe({
          next: () => {
            this.snackBar.open('Benutzer erstellt', 'OK', { duration: 2000 });
            this.loadUsers();
          },
          error: (err) => {
            this.snackBar.open('Fehler: ' + (err.error?.detail || 'Serverfehler'), 'OK');
          }
        });
      }
    });
  }

  setBulkLines(value: string): void {
    this.bulkLines = value;
  }

  bulkImportUsers(): void {
    const lines = this.bulkLines.trim();
    if (!lines) {
      this.snackBar.open('Bitte mindestens eine Zeile mit vollem Namen einfügen.', 'OK', { duration: 2500 });
      return;
    }

    this.bulkLoading = true;
    this.bulkResult = null;

    this.api.post('/api/users/bulk-import/', this.auth.token(), { lines }).subscribe({
      next: (res: BulkImportResponse | any) => {
        this.bulkLoading = false;

        if (Array.isArray(res) && res.length > 0 && res[0]?.error_code !== undefined) {
          this.snackBar.open('Bulk-Import fehlgeschlagen.', 'OK', { duration: 3000 });
          return;
        }

        this.bulkResult = res as BulkImportResponse;
        this.loadUsers();
        this.snackBar.open(`${this.bulkResult.created_count} Nutzer importiert.`, 'OK', { duration: 2400 });
      },
      error: (err) => {
        this.bulkLoading = false;
        const msg = err?.error?.detail || 'Bulk-Import fehlgeschlagen';
        this.snackBar.open(msg, 'OK', { duration: 3000 });
      },
    });
  }

  copyLink(link: string): void {
    if (!link) return;

    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
      this.snackBar.open('Clipboard im Browser nicht verfügbar.', 'OK', { duration: 2200 });
      return;
    }

    navigator.clipboard
      .writeText(link)
      .then(() => this.snackBar.open('Login-Link kopiert.', 'OK', { duration: 1800 }))
      .catch(() => this.snackBar.open('Link konnte nicht kopiert werden.', 'OK', { duration: 2200 }));
  }

  copyUserLoginLink(user: User): void {
    if (!this.canUserLinkActions(user)) {
      this.snackBar.open('Nur für Nutzer ohne Adminrechte möglich.', 'OK', { duration: 2200 });
      return;
    }

    this.api.post(`/api/users/${user.id}/login-link/`, this.auth.token(), {}).subscribe((res: any) => {
      if (this.isApiError(res)) {
        this.snackBar.open('Login-Link konnte nicht erzeugt werden.', 'OK', { duration: 2500 });
        return;
      }

      const loginLink = String(res?.login_link || '');
      if (!loginLink) {
        this.snackBar.open('Login-Link fehlt in der Antwort.', 'OK', { duration: 2500 });
        return;
      }

      this.copyLink(loginLink);
    });
  }

  reprintWelcome(user: User): void {
    if (!this.canUserLinkActions(user)) {
      this.snackBar.open('Nur für Nutzer ohne Adminrechte möglich.', 'OK', { duration: 2200 });
      return;
    }

    this.api.post(`/api/users/${user.id}/reprint-welcome/`, this.auth.token(), {}).subscribe((res: any) => {
      if (this.isApiError(res)) {
        this.snackBar.open('Druck konnte nicht gestartet werden.', 'OK', { duration: 2500 });
        return;
      }

      const status = String(res?.status || '');
      if (status === 'printed') {
        this.snackBar.open('Willkommenstext wurde gedruckt.', 'OK', { duration: 2200 });
        return;
      }

      if (status === 'printer_not_configured') {
        this.snackBar.open('Drucker nicht konfiguriert.', 'OK', { duration: 2500 });
        return;
      }

      if (status === 'printer_offline') {
        const msg = String(res?.message || 'Drucker nicht erreichbar.');
        this.snackBar.open(msg, 'OK', { duration: 3200 });
        return;
      }

      this.snackBar.open('Druckstatus unbekannt.', 'OK', { duration: 2500 });
    });
  }

  printerStatusLabel(status: string): string {
    const normalized = String(status || '').toLowerCase();
    if (normalized === 'printed') return 'Gedruckt';
    if (normalized === 'printer_offline') return 'Drucker offline';
    if (normalized === 'printer_not_configured') return 'Kein Drucker konfiguriert';
    return 'Übersprungen';
  }

  private isApiError(response: any): boolean {
    return Array.isArray(response) && response.length > 0 && response[0]?.error_code !== undefined;
  }
}
