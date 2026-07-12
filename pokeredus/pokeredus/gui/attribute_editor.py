"""
Attribute Editor Dialog

GUI for viewing and managing attributes on items, abilities, and moves.
Allows adding common presets or custom attributes.
"""
import tkinter as tk
from tkinter import ttk, messagebox
from typing import List, Optional, Dict, Any

from pokeredus.gui.theme import *
from pokeredus.graph.attribute_manager import AttributeManager, AttributeDefinition
from pokeredus.graph.common_attributes import (
    COMMON_ITEM_ATTRIBUTES,
    COMMON_ABILITY_ATTRIBUTES,
    COMMON_MOVE_ATTRIBUTES,
)


class AttributeEditorDialog(tk.Toplevel):
    """Dialog for editing attributes on an item, ability, or move."""
    
    ATTRIBUTE_TYPES = [
        "stat_mod",
        "damage_mod",
        "speed_mod",
        "condition",
        "field",
        "event",
        "immunity",
        "recovery",
    ]
    
    def __init__(
        self,
        parent: tk.Widget,
        entity_type: str,  # "item", "ability", or "move"
        entity_id: str,
        entity_name: str,
        attribute_manager: AttributeManager,
    ):
        super().__init__(parent)
        self.title(f"Edit Attributes - {entity_name}")
        self.configure(bg=BG_DARK)
        self.geometry("900x700")
        self.transient(parent)
        self.grab_set()
        
        self.entity_type = entity_type
        self.entity_id = entity_id
        self.entity_name = entity_name
        self.attribute_manager = attribute_manager
        
        # Load current attributes
        self.attributes: List[AttributeDefinition] = self._load_attributes()
        
        # Build UI
        self._build_ui()
        
        # Center on parent
        self.update_idletasks()
        x = parent.winfo_x() + (parent.winfo_width() - self.winfo_width()) // 2
        y = parent.winfo_y() + (parent.winfo_height() - self.winfo_height()) // 2
        self.geometry(f"+{x}+{y}")
    
    def _load_attributes(self) -> List[AttributeDefinition]:
        """Load current attributes for the entity."""
        if self.entity_type == "item":
            return self.attribute_manager.get_item_attributes(self.entity_id)
        elif self.entity_type == "ability":
            return self.attribute_manager.get_ability_attributes(self.entity_id)
        elif self.entity_type == "move":
            return self.attribute_manager.get_move_attributes(self.entity_id)
        return []
    
    def _save_attributes(self):
        """Save attributes for the entity."""
        if self.entity_type == "item":
            self.attribute_manager.set_item_attributes(self.entity_id, self.attributes)
        elif self.entity_type == "ability":
            self.attribute_manager.set_ability_attributes(self.entity_id, self.attributes)
        elif self.entity_type == "move":
            self.attribute_manager.set_move_attributes(self.entity_id, self.attributes)
    
    def _build_ui(self):
        """Build the dialog UI."""
        # Header
        header = tk.Frame(self, bg=BG_PANEL, height=60)
        header.pack(fill="x")
        header.pack_propagate(False)
        
        tk.Label(
            header,
            text=f"{self.entity_type.title()}: {self.entity_name}",
            font=FONT_HEADING,
            fg=FG_PRIMARY,
            bg=BG_PANEL,
        ).pack(side="left", padx=20, pady=10)
        
        # Main content
        content = tk.Frame(self, bg=BG_DARK)
        content.pack(fill="both", expand=True, padx=20, pady=10)
        
        # Left panel: Current attributes
        left_panel = tk.Frame(content, bg=BG_DARK)
        left_panel.pack(side="left", fill="both", expand=True, padx=(0, 10))
        
        tk.Label(
            left_panel,
            text="Current Attributes",
            font=FONT_SUBTITLE,
            fg=FG_PRIMARY,
            bg=BG_DARK,
        ).pack(anchor="w", pady=(0, 10))
        
        # Scrollable frame for attributes
        attr_container = tk.Frame(left_panel, bg=BG_CARD)
        attr_container.pack(fill="both", expand=True)
        
        canvas = tk.Canvas(attr_container, bg=BG_CARD, highlightthickness=0)
        scrollbar = ttk.Scrollbar(attr_container, orient="vertical", command=canvas.yview)
        self.attr_frame = tk.Frame(canvas, bg=BG_CARD)
        
        self.attr_frame.bind(
            "<Configure>",
            lambda e: canvas.configure(scrollregion=canvas.bbox("all"))
        )
        
        canvas.create_window((0, 0), window=self.attr_frame, anchor="nw")
        canvas.configure(yscrollcommand=scrollbar.set)
        
        canvas.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")
        
        # Buttons below current attributes
        btn_frame = tk.Frame(left_panel, bg=BG_DARK)
        btn_frame.pack(fill="x", pady=(10, 0))
        
        tk.Button(
            btn_frame,
            text="Add Custom Attribute",
            font=FONT_BUTTON,
            fg=FG_PRIMARY,
            bg=BG_CARD,
            activebackground=BG_INPUT,
            activeforeground=FG_PRIMARY,
            command=self._add_custom_attribute,
        ).pack(side="left", padx=(0, 5))
        
        tk.Button(
            btn_frame,
            text="Clear All",
            font=FONT_BUTTON,
            fg=NEON_RED,
            bg=BG_CARD,
            activebackground=BG_INPUT,
            activeforeground=NEON_RED,
            command=self._clear_all,
        ).pack(side="left")
        
        # Right panel: Common presets
        right_panel = tk.Frame(content, bg=BG_DARK)
        right_panel.pack(side="right", fill="both", expand=True, padx=(10, 0))
        
        tk.Label(
            right_panel,
            text="Common Presets",
            font=FONT_SUBTITLE,
            fg=FG_PRIMARY,
            bg=BG_DARK,
        ).pack(anchor="w", pady=(0, 10))
        
        # Scrollable frame for presets
        preset_container = tk.Frame(right_panel, bg=BG_CARD)
        preset_container.pack(fill="both", expand=True)
        
        preset_canvas = tk.Canvas(preset_container, bg=BG_CARD, highlightthickness=0)
        preset_scrollbar = ttk.Scrollbar(preset_container, orient="vertical", command=preset_canvas.yview)
        self.preset_frame = tk.Frame(preset_canvas, bg=BG_CARD)
        
        self.preset_frame.bind(
            "<Configure>",
            lambda e: preset_canvas.configure(scrollregion=preset_canvas.bbox("all"))
        )
        
        preset_canvas.create_window((0, 0), window=self.preset_frame, anchor="nw")
        preset_canvas.configure(yscrollcommand=preset_scrollbar.set)
        
        preset_canvas.pack(side="left", fill="both", expand=True)
        preset_scrollbar.pack(side="right", fill="y")
        
        # Bottom buttons
        bottom_frame = tk.Frame(self, bg=BG_PANEL, height=60)
        bottom_frame.pack(fill="x")
        bottom_frame.pack_propagate(False)
        
        tk.Button(
            bottom_frame,
            text="Save & Close",
            font=FONT_BUTTON,
            fg=NEON_GREEN,
            bg=BG_CARD,
            activebackground=BG_INPUT,
            activeforeground=NEON_GREEN,
            command=self._save_and_close,
        ).pack(side="right", padx=20, pady=10)
        
        tk.Button(
            bottom_frame,
            text="Cancel",
            font=FONT_BUTTON,
            fg=FG_SECONDARY,
            bg=BG_CARD,
            activebackground=BG_INPUT,
            activeforeground=FG_SECONDARY,
            command=self.destroy,
        ).pack(side="right", padx=10, pady=10)
        
        # Populate attributes and presets
        self._refresh_attributes()
        self._populate_presets()
    
    def _refresh_attributes(self):
        """Refresh the current attributes display."""
        # Clear existing
        for widget in self.attr_frame.winfo_children():
            widget.destroy()
        
        if not self.attributes:
            tk.Label(
                self.attr_frame,
                text="No attributes defined",
                font=FONT_BODY,
                fg=FG_DIM,
                bg=BG_CARD,
            ).pack(pady=20)
            return
        
        # Display each attribute
        for i, attr in enumerate(self.attributes):
            self._create_attribute_card(self.attr_frame, attr, i)
    
    def _create_attribute_card(self, parent: tk.Frame, attr: AttributeDefinition, index: int):
        """Create a card for displaying an attribute."""
        card = tk.Frame(parent, bg=BG_INPUT, padx=10, pady=10)
        card.pack(fill="x", pady=5, padx=10)
        
        # Header row
        header = tk.Frame(card, bg=BG_INPUT)
        header.pack(fill="x")
        
        tk.Label(
            header,
            text=attr.name,
            font=FONT_BODY_BOLD,
            fg=NEON_CYAN,
            bg=BG_INPUT,
        ).pack(side="left")
        
        tk.Label(
            header,
            text=f"[{attr.type}]",
            font=FONT_SMALL,
            fg=FG_SECONDARY,
            bg=BG_INPUT,
        ).pack(side="left", padx=10)
        
        # Remove button
        tk.Button(
            header,
            text="×",
            font=("Arial", 16, "bold"),
            fg=NEON_RED,
            bg=BG_INPUT,
            activebackground=BG_HOVER,
            activeforeground=NEON_RED,
            bd=0,
            command=lambda: self._remove_attribute(index),
        ).pack(side="right")
        
        # Description
        if attr.description:
            tk.Label(
                card,
                text=attr.description,
                font=FONT_SMALL,
                fg=FG_PRIMARY,
                bg=BG_INPUT,
                wraplength=400,
                justify="left",
            ).pack(anchor="w", pady=(5, 0))
        
        # Parameters
        if attr.params:
            params_text = ", ".join(f"{k}={v}" for k, v in attr.params.items())
            tk.Label(
                card,
                text=f"Params: {params_text}",
                font=("Courier", 9),
                fg=FG_SECONDARY,
                bg=BG_INPUT,
                wraplength=400,
                justify="left",
            ).pack(anchor="w", pady=(5, 0))
        
        # Tags
        if attr.tags:
            tk.Label(
                card,
                text=f"Tags: {', '.join(attr.tags)}",
                font=FONT_SMALL,
                fg=FG_DIM,
                bg=BG_INPUT,
            ).pack(anchor="w", pady=(5, 0))
    
    def _populate_presets(self):
        """Populate the common presets panel."""
        # Clear existing
        for widget in self.preset_frame.winfo_children():
            widget.destroy()
        
        # Get presets for this entity type
        if self.entity_type == "item":
            presets = COMMON_ITEM_ATTRIBUTES
        elif self.entity_type == "ability":
            presets = COMMON_ABILITY_ATTRIBUTES
        elif self.entity_type == "move":
            presets = COMMON_MOVE_ATTRIBUTES
        else:
            presets = {}
        
        if not presets:
            tk.Label(
                self.preset_frame,
                text="No presets available",
                font=FONT_BODY,
                fg=FG_DIM,
                bg=BG_CARD,
            ).pack(pady=20)
            return
        
        # Display each preset
        for preset_id, preset in presets.items():
            self._create_preset_card(self.preset_frame, preset)
    
    def _create_preset_card(self, parent: tk.Frame, preset: AttributeDefinition):
        """Create a card for a preset attribute."""
        card = tk.Frame(parent, bg=BG_INPUT, padx=10, pady=10)
        card.pack(fill="x", pady=5, padx=10)
        
        # Header
        header = tk.Frame(card, bg=BG_INPUT)
        header.pack(fill="x")
        
        tk.Label(
            header,
            text=preset.name,
            font=FONT_BODY_BOLD,
            fg=NEON_CYAN,
            bg=BG_INPUT,
        ).pack(side="left")
        
        # Add button
        tk.Button(
            header,
            text="+",
            font=("Arial", 16, "bold"),
            fg=NEON_GREEN,
            bg=BG_INPUT,
            activebackground=BG_HOVER,
            activeforeground=NEON_GREEN,
            bd=0,
            command=lambda: self._add_preset(preset),
        ).pack(side="right")
        
        # Description
        if preset.description:
            tk.Label(
                card,
                text=preset.description,
                font=FONT_SMALL,
                fg=FG_PRIMARY,
                bg=BG_INPUT,
                wraplength=300,
                justify="left",
            ).pack(anchor="w", pady=(5, 0))
    
    def _add_preset(self, preset: AttributeDefinition):
        """Add a preset attribute."""
        # Check if already exists
        if any(attr.id == preset.id for attr in self.attributes):
            messagebox.showwarning(
                "Duplicate",
                f"Attribute '{preset.name}' already exists",
                parent=self,
            )
            return
        
        # Add to list
        self.attributes.append(preset)
        self._refresh_attributes()
    
    def _add_custom_attribute(self):
        """Open dialog to add a custom attribute."""
        dialog = CustomAttributeDialog(self)
        self.wait_window(dialog)
        
        if dialog.result:
            self.attributes.append(dialog.result)
            self._refresh_attributes()
    
    def _remove_attribute(self, index: int):
        """Remove an attribute by index."""
        if 0 <= index < len(self.attributes):
            attr = self.attributes[index]
            if messagebox.askyesno(
                "Remove Attribute",
                f"Remove '{attr.name}'?",
                parent=self,
            ):
                self.attributes.pop(index)
                self._refresh_attributes()
    
    def _clear_all(self):
        """Clear all attributes."""
        if self.attributes and messagebox.askyesno(
            "Clear All",
            "Remove all attributes?",
            parent=self,
        ):
            self.attributes.clear()
            self._refresh_attributes()
    
    def _save_and_close(self):
        """Save attributes and close dialog."""
        self._save_attributes()
        messagebox.showinfo(
            "Saved",
            f"Attributes saved for {self.entity_name}",
            parent=self,
        )
        self.destroy()


class CustomAttributeDialog(tk.Toplevel):
    """Dialog for creating a custom attribute."""
    
    ATTRIBUTE_TYPES = [
        "stat_mod",
        "damage_mod",
        "speed_mod",
        "condition",
        "field",
        "event",
        "immunity",
        "recovery",
    ]
    
    def __init__(self, parent: tk.Widget):
        super().__init__(parent)
        self.title("Add Custom Attribute")
        self.configure(bg=BG_DARK)
        self.geometry("600x500")
        self.transient(parent)
        self.grab_set()
        
        self.result: Optional[AttributeDefinition] = None
        
        self._build_ui()
        
        # Center on parent
        self.update_idletasks()
        x = parent.winfo_x() + (parent.winfo_width() - self.winfo_width()) // 2
        y = parent.winfo_y() + (parent.winfo_height() - self.winfo_height()) // 2
        self.geometry(f"+{x}+{y}")
    
    def _build_ui(self):
        """Build the dialog UI."""
        # Form
        form = tk.Frame(self, bg=BG_DARK)
        form.pack(fill="both", expand=True, padx=20, pady=20)
        
        # ID
        tk.Label(form, text="ID:", font=FONT_BODY, fg=FG_PRIMARY, bg=BG_DARK).pack(anchor="w")
        self.id_var = tk.StringVar()
        tk.Entry(
            form,
            textvariable=self.id_var,
            font=FONT_BODY,
            bg=BG_CARD,
            fg=FG_PRIMARY,
            insertbackground=FG_PRIMARY,
        ).pack(fill="x", pady=(0, 10))
        
        # Name
        tk.Label(form, text="Name:", font=FONT_BODY, fg=FG_PRIMARY, bg=BG_DARK).pack(anchor="w")
        self.name_var = tk.StringVar()
        tk.Entry(
            form,
            textvariable=self.name_var,
            font=FONT_BODY,
            bg=BG_CARD,
            fg=FG_PRIMARY,
            insertbackground=FG_PRIMARY,
        ).pack(fill="x", pady=(0, 10))
        
        # Type
        tk.Label(form, text="Type:", font=FONT_BODY, fg=FG_PRIMARY, bg=BG_DARK).pack(anchor="w")
        self.type_var = tk.StringVar(value="stat_mod")
        type_menu = ttk.Combobox(
            form,
            textvariable=self.type_var,
            values=self.ATTRIBUTE_TYPES,
            state="readonly",
            font=FONT_BODY,
        )
        type_menu.pack(fill="x", pady=(0, 10))
        
        # Description
        tk.Label(form, text="Description:", font=FONT_BODY, fg=FG_PRIMARY, bg=BG_DARK).pack(anchor="w")
        self.desc_text = tk.Text(
            form,
            font=FONT_BODY,
            bg=BG_CARD,
            fg=FG_PRIMARY,
            insertbackground=FG_PRIMARY,
            height=3,
        )
        self.desc_text.pack(fill="x", pady=(0, 10))
        
        # Tags
        tk.Label(form, text="Tags (comma-separated):", font=FONT_BODY, fg=FG_PRIMARY, bg=BG_DARK).pack(anchor="w")
        self.tags_var = tk.StringVar()
        tk.Entry(
            form,
            textvariable=self.tags_var,
            font=FONT_BODY,
            bg=BG_CARD,
            fg=FG_PRIMARY,
            insertbackground=FG_PRIMARY,
        ).pack(fill="x", pady=(0, 10))
        
        # Info about params
        tk.Label(
            form,
            text="Note: Parameters can be added after creation by editing the JSON file directly.",
            font=FONT_SMALL,
            fg=FG_DIM,
            bg=BG_DARK,
            wraplength=550,
        ).pack(anchor="w", pady=(10, 0))
        
        # Buttons
        btn_frame = tk.Frame(self, bg=BG_PANEL, height=60)
        btn_frame.pack(fill="x")
        btn_frame.pack_propagate(False)
        
        tk.Button(
            btn_frame,
            text="Add",
            font=FONT_BUTTON,
            fg=NEON_GREEN,
            bg=BG_CARD,
            activebackground=BG_INPUT,
            activeforeground=NEON_GREEN,
            command=self._add,
        ).pack(side="right", padx=20, pady=10)
        
        tk.Button(
            btn_frame,
            text="Cancel",
            font=FONT_BUTTON,
            fg=FG_SECONDARY,
            bg=BG_CARD,
            activebackground=BG_INPUT,
            activeforeground=FG_SECONDARY,
            command=self.destroy,
        ).pack(side="right", padx=10, pady=10)
    
    def _add(self):
        """Validate and add the attribute."""
        attr_id = self.id_var.get().strip()
        name = self.name_var.get().strip()
        attr_type = self.type_var.get()
        description = self.desc_text.get("1.0", "end-1c").strip()
        tags_str = self.tags_var.get().strip()
        
        if not attr_id:
            messagebox.showerror("Error", "ID is required", parent=self)
            return
        
        if not name:
            messagebox.showerror("Error", "Name is required", parent=self)
            return
        
        # Parse tags
        tags = [t.strip() for t in tags_str.split(",") if t.strip()]
        
        # Create attribute
        self.result = AttributeDefinition(
            id=attr_id,
            name=name,
            type=attr_type,
            description=description,
            params={},  # Empty params, can be edited later
            tags=tags,
        )
        
        self.destroy()
