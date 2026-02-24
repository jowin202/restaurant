import { Component, Inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatSelectModule } from '@angular/material/select';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatNativeDateModule } from '@angular/material/core';

@Component({
  standalone: true,
  imports: [
    CommonModule, FormsModule, MatDialogModule, MatFormFieldModule,
    MatInputModule, MatButtonModule, MatSelectModule,
    MatDatepickerModule, MatNativeDateModule
  ],
  template: `
    <h2 mat-dialog-title>{{ data.label }} bearbeiten</h2>
    <mat-dialog-content>
      <div style="padding-top: 15px; min-width: 350px;">
        
        @if (data.type === 'select') {
          <mat-form-field appearance="outline" class="full-width">
            <mat-label>{{ data.label }}</mat-label>
            <mat-select [(ngModel)]="data.value">
              @for (opt of data.options; track opt.key) {
                <mat-option [value]="opt.key">{{ opt.value }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
        } 
        
        @else if (data.type === 'date') {
          <mat-form-field appearance="outline" class="full-width">
            <mat-label>{{ data.label }}</mat-label>
            <input matInput [matDatepicker]="picker" [(ngModel)]="data.value" placeholder="TT.MM.JJJJ" (keyup.enter)="save()">
            <mat-datepicker-toggle matIconSuffix [for]="picker"></mat-datepicker-toggle>
            <mat-datepicker #picker></mat-datepicker>
          </mat-form-field>
        } 
        @else if (data.type === 'boolean') {
        <div style="padding: 10px 0;">
          <mat-checkbox [(ngModel)]="data.value">{{ data.label }}</mat-checkbox>
        </div>
        }
        @else {
          <mat-form-field appearance="outline" class="full-width">
            <mat-label>{{ data.label }}</mat-label>
            <input matInput [type]="data.type || 'text'" [(ngModel)]="data.value" (keyup.enter)="save()">
          </mat-form-field>
        }

      </div>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button (click)="onNoClick()">Abbrechen</button>
      <button mat-raised-button color="primary" (click)="save()">Speichern</button>
    </mat-dialog-actions>
  `,
  styles: [`
    .full-width {
      width: 100%;
    }
    /* Stellt sicher, dass das Flex-Layout des Form-Fields nicht umbricht */
    :host ::ng-deep .mat-mdc-form-field-flex {
      display: flex !important;
      align-items: center !important;
    }
  `]
})
export class EditFieldDialog {
  constructor(
    public dialogRef: MatDialogRef<EditFieldDialog>,
    @Inject(MAT_DIALOG_DATA) public data: any
  ) {
    if (this.data.type === 'date' && typeof this.data.value === 'string' && this.data.value) {
      this.data.value = new Date(this.data.value);
    }
  }

  onNoClick(): void { this.dialogRef.close(); }
  save() { this.dialogRef.close(this.data.value); }
}