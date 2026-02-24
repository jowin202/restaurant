import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatNativeDateModule } from '@angular/material/core';

@Component({
  selector: 'app-add-besitzer-dialog',
  standalone: true,
  imports: [
    CommonModule, FormsModule, MatDialogModule, MatFormFieldModule, 
    MatInputModule, MatButtonModule, MatDatepickerModule, MatNativeDateModule
  ],
  templateUrl: './add-besitzer-dialog.html'
})
export class AddBesitzerDialog {
  private dialogRef = inject(MatDialogRef<AddBesitzerDialog>);
  
  // Initialisierung der Daten mit Standardwerten
  data = {
    name: '',
    wohnort: '',
    mail: '',
    datum: new Date() // Standardmäßig heute
  };

  save() {
    // Wir geben das Objekt zurück, wenn Name und Wohnort (Pflichtfelder laut besitzer.py) ausgefüllt sind
    if (this.data.name && this.data.wohnort) {
      this.dialogRef.close(this.data);
    }
  }

  cancel() {
    this.dialogRef.close();
  }
}