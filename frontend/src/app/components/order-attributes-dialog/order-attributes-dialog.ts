import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { ReactiveFormsModule, UntypedFormControl, UntypedFormGroup, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';

export type OrderInputType = 'string' | 'select' | 'boolean';

export interface OrderAttributeDefinition {
  key: string;
  label: string;
  input_type: OrderInputType;
  required: boolean;
  options: string[];
}

export interface OrderAttributesDialogData {
  itemName: string;
  attributes: OrderAttributeDefinition[];
  initialAnswers: Record<string, any>;
}

@Component({
  selector: 'app-order-attributes-dialog',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatCheckboxModule,
    MatButtonModule,
  ],
  templateUrl: './order-attributes-dialog.html',
  styleUrl: './order-attributes-dialog.css',
})
export class OrderAttributesDialog {
  readonly dialogRef = inject(MatDialogRef<OrderAttributesDialog, Record<string, any> | null>);
  readonly data = inject<OrderAttributesDialogData>(MAT_DIALOG_DATA);

  form = new UntypedFormGroup({});

  constructor() {
    for (const attr of this.data.attributes) {
      const initial = this.data.initialAnswers[attr.key];

      if (attr.input_type === 'boolean') {
        this.form.addControl(attr.key, new UntypedFormControl(typeof initial === 'boolean' ? initial : false));
        continue;
      }

      const validators = attr.required ? [Validators.required] : [];
      this.form.addControl(attr.key, new UntypedFormControl(typeof initial === 'string' ? initial : '', validators));
    }
  }

  cancel(): void {
    this.dialogRef.close(null);
  }

  submit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    const raw = this.form.getRawValue() as Record<string, any>;
    const answers: Record<string, any> = {};

    for (const attr of this.data.attributes) {
      const value = raw[attr.key];

      if (attr.input_type === 'boolean') {
        answers[attr.key] = Boolean(value);
        continue;
      }

      const textValue = typeof value === 'string' ? value.trim() : '';
      if (textValue.length > 0) {
        answers[attr.key] = textValue;
      }
    }

    this.dialogRef.close(answers);
  }
}
