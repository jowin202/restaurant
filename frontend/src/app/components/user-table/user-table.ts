import { ChangeDetectorRef, Component, Inject } from '@angular/core';
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


export interface User {
  id: number;
  username: string;
  name: string;
  mail: string;
  admin: number;
}


@Component({
  selector: 'app-user-table',
  imports: [MatTableModule, MatIconModule, MatChipsModule, MatButtonModule, MatTooltipModule],
  templateUrl: './user-table.html',
  styleUrl: './user-table.css',
})
export class UserTable {
  users: User[] = [];
  displayedColumns: string[] = ['id', 'username', 'name', 'mail', 'role', 'actions'];

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
}