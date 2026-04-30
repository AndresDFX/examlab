# VetCare — Respuesta de prueba: MALA (~10-25/100)

> Entrega muy pobre: respuestas vagas, código que no compila o pseudocódigo,
> diagramas en ASCII art que no son sintaxis válida de Mermaid/PlantUML, sin
> manejo de errores, sin persistencia real. Sirve para verificar que la IA
> detecta y penaliza este tipo de entrega.

---

## ============ CAJA 1: Levantamiento de requisitos (15 pts) ============

VetCare es un sistema para una veterinaria.

Va a tener clientes, mascotas y citas.

Se hace en Java.


## ============ CAJA 2: Diagrama UML — Casos de Uso (15 pts) ============

  +------------------+
  |   Recepcionista  |
  +------------------+
          |
          v
   [Registrar todo]
          |
          v
   [Agendar citas]


## ============ CAJA 3: Diagrama UML — Diagrama de Clases (15 pts) ============

Cliente
- nombre
- mascotas

Mascota
- nombre
- edad

Cita
- fecha


## ============ CAJA 4: Código Java — Modelo de dominio y colecciones (15 pts) ============

class Cliente {
    String nombre;
    String documento;
}

class Mascota {
    String nombre;
    int edad;
}

class Cita {
    String fecha;
}

// El service va aqui (todavia no lo hicimos)


## ============ CAJA 5: Código Java — GUI + Manejo de errores (15 pts) ============

import javax.swing.*;

public class App {
    public static void main(String[] args) {
        JFrame f = new JFrame();
        f.setVisible(true);
        // aqui van los formularios cuando los hagamos
    }
}


## ============ CAJA 6: Código Java — Persistencia en archivos (10 pts) ============

// se va a guardar en archivos .txt
// pero todavia no esta hecho


## ============ CAJA 7: Plan de Pruebas (QA) y Manual (15 pts) ============

Pruebas:
1. Probar que abra la ventana
2. Probar que se cierre

Manual:
- Abrir el programa con doble click
- Llenar los datos
- Cerrar
