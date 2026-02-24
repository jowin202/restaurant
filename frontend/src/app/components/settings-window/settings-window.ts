import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.services';

@Component({
  selector: 'app-einstellungen',
  standalone: true,
  imports: [
    CommonModule, ReactiveFormsModule, MatFormFieldModule, 
    MatInputModule, MatButtonModule, MatCardModule, MatIconModule
  ],
  templateUrl: './settings-window.html',
  styleUrls: ['./../hund-steckbrief/hund-steckbrief.css']
})
export class SettingsWindow implements OnInit {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private snackBar = inject(MatSnackBar);

  // Wir definieren hier zentral, welche Keys wir abfragen wollen
  private settingsKeys = ['zuchtbuchstelle', 'geschaeftsstelle'];

  form = new FormGroup({
    zuchtbuchstelle: new FormControl(''),
    geschaeftsstelle: new FormControl('')
  });

  ngOnInit() {
    this.loadSettings();
  }

  loadSettings() {
    // Wir senden das Array mit den gewünschten Keys im Body
    this.api.post('/api/settings/get_settings/', this.auth.token(), this.settingsKeys).subscribe({
      next: (settings: any) => {
        // Falls die API ein Dictionary zurückgibt: { "zuchtbuchstelle": "Wert", ... }
        this.form.patchValue({
          zuchtbuchstelle: settings.zuchtbuchstelle || '',
          geschaeftsstelle: settings.geschaeftsstelle || ''
        });
      },
      error: (err) => console.error("Fehler beim Laden der Einstellungen", err)
    });
  }

  onSubmit() {
    // set_settings schickt weiterhin das Key-Value Dict
    this.api.post('/api/settings/set_settings/', this.auth.token(), this.form.value).subscribe({
      next: () => {
        this.snackBar.open('Einstellungen erfolgreich gespeichert!', 'OK', { duration: 3000 });
      },
      error: (err) => {
        this.snackBar.open('Fehler beim Speichern.', 'X');
        console.error(err);
      }
    });
  }
}