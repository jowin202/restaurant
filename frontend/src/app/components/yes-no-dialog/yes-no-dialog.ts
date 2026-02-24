import { Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogActions, MatDialogContent, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';


export interface DialogData {
  head: string;
  body: string;
}

@Component({
  selector: 'app-yes-no-dialog',
  imports: [MatDialogModule, MatDialogContent, MatDialogActions,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
  ],
  templateUrl: './yes-no-dialog.html',
  styleUrl: './yes-no-dialog.scss',
})
export class YesNoDialog {
  
  readonly dialogRef = inject(MatDialogRef<YesNoDialog>);
  readonly data = inject<DialogData>(MAT_DIALOG_DATA);
  
}
