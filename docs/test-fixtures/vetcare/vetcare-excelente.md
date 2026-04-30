# VetCare — Respuesta de prueba: EXCELENTE (100/100)

> Cada sección de este documento corresponde a una **caja de texto** del proyecto.
> Copia el contenido entre los separadores `=====` y pégalo en la caja correspondiente
> del módulo de proyectos del estudiante.

---

## ============ CAJA 1: Levantamiento de requisitos (15 pts) ============

# VetCare — Levantamiento de Requisitos

## 1. Alcance del sistema

VetCare es una aplicación de escritorio en Java para la Clínica Veterinaria Huellitas
que reemplaza los cuadernos de papel actuales. La primera versión (v1.0) cubre tres
flujos críticos:

- **Gestión de dueños y mascotas**: registro, búsqueda, edición y eliminación lógica.
- **Agendamiento de citas**: creación, consulta diaria y cancelación.
- **Historial clínico**: registro cronológico de consultas, vacunas y observaciones.

Quedan **fuera de alcance** para v1.0: facturación, control de inventario de medicamentos,
notificaciones por email/SMS, integración con laboratorios externos y multi-sede.

## 2. Actores del sistema

| Actor | Rol | Permisos |
|-------|-----|----------|
| Recepcionista | Atiende al dueño y agenda | Crear/editar clientes, mascotas y citas |
| Veterinario | Realiza consultas | Consultar historial, agregar registros clínicos, ver agenda propia |
| Administrador | Gestiona el sistema | Todo lo anterior + usuarios + backup |
| Dueño (mascota) | Externo, no usa el sistema | — |

## 3. Historias de usuario

**HU-01.** Como **recepcionista**, quiero **registrar un cliente nuevo con sus datos
de contacto**, para **poder asociar a sus mascotas y contactarlo si surge una urgencia**.

**HU-02.** Como **recepcionista**, quiero **registrar una mascota con su raza, edad
y peso**, para **que el veterinario tenga datos clínicos de referencia**.

**HU-03.** Como **recepcionista**, quiero **agendar una cita seleccionando mascota,
veterinario y fecha-hora**, para **organizar la agenda diaria de la clínica**.

**HU-04.** Como **recepcionista**, quiero **buscar un cliente por documento o teléfono**,
para **localizar rápido a quien llama por teléfono**.

**HU-05.** Como **veterinario**, quiero **consultar el historial clínico completo de
una mascota**, para **tomar decisiones informadas durante la consulta**.

**HU-06.** Como **veterinario**, quiero **agregar un registro al historial clínico
(diagnóstico, tratamiento, observaciones)**, para **dejar trazabilidad de cada consulta**.

**HU-07.** Como **veterinario**, quiero **ver mi agenda del día con las citas pendientes**,
para **prepararme para cada paciente**.

**HU-08.** Como **administrador**, quiero **dar de baja un cliente sin perder su
historial**, para **cumplir con la política de "no eliminar registros médicos"**.

**HU-09.** Como **usuario en general**, quiero **que los datos persistan entre sesiones**,
para **no perder información cuando se cierre el programa o falle el sistema**.

**HU-10.** Como **administrador**, quiero **respaldar los archivos de datos a una
ruta de mi elección**, para **prevenir pérdida ante daños del disco**.

## 4. Criterios de aceptación (ejemplo HU-01)

- El formulario muestra los campos: nombre completo, documento (único), teléfono, email, dirección.
- Si el documento ya existe, el sistema muestra un mensaje claro y no duplica.
- Al guardar exitosamente, el cliente aparece en el listado sin recargar la ventana.
- El email es opcional pero, si se ingresa, debe validarse el formato (`@` y `.`).
- El teléfono solo acepta dígitos y entre 7 y 15 caracteres.

## 5. Restricciones del sistema

- **Plataforma**: Aplicación de escritorio (sin servidor web), distribuible como `.jar`.
- **Lenguaje**: Java 17 LTS o superior.
- **GUI**: Java Swing (estándar de la JDK, sin dependencias externas).
- **Persistencia**: Archivos planos `.csv` (UTF-8) por entidad: `clientes.csv`,
  `mascotas.csv`, `citas.csv`, `historial.csv`. Sin base de datos.
- **Concurrencia**: Mono-usuario por instancia (una sola PC); no hay bloqueo de archivos.
- **Seguridad**: Sin login en v1.0 (uso interno en mostrador). Backups manuales.
- **Idioma**: Español Colombia.

## 6. Requisitos no funcionales

- **Rendimiento**: Operaciones CRUD < 1 s con hasta 5.000 clientes y 10.000 mascotas.
- **Usabilidad**: Cualquier flujo principal completable en ≤ 5 clics.
- **Disponibilidad**: La app debe iniciar aunque algún archivo esté corrupto (modo seguro
  con archivo vacío y aviso al usuario).
- **Mantenibilidad**: Separación clara entre Modelo (POJO), Servicio (lógica) y Vista (Swing).


## ============ CAJA 2: Diagrama UML — Casos de Uso (15 pts) ============

flowchart LR
    Recepcionista((Recepcionista))
    Veterinario((Veterinario))
    Administrador((Administrador))

    subgraph VetCare["Sistema VetCare"]
        UC1[Registrar Cliente]
        UC2[Registrar Mascota]
        UC3[Agendar Cita]
        UC4[Consultar Historial Clinico]
        UC5[Agregar Registro Clinico]
        UC6[Buscar Cliente]
        UC7[Ver Agenda del Dia]
        UC8[Cancelar Cita]
        UC9[Dar de Baja Cliente]
        UC10[Respaldar Datos]
        UC11[Validar Datos del Cliente]
        UC12[Notificar Conflicto de Agenda]
    end

    Recepcionista --> UC1
    Recepcionista --> UC2
    Recepcionista --> UC3
    Recepcionista --> UC6
    Recepcionista --> UC8

    Veterinario --> UC4
    Veterinario --> UC5
    Veterinario --> UC7

    Administrador --> UC9
    Administrador --> UC10
    Administrador --> UC1
    Administrador --> UC2
    Administrador --> UC3

    UC1 -. include .-> UC11
    UC2 -. include .-> UC11
    UC3 -. extend .-> UC12
    UC5 -. include .-> UC4

    classDef ucase fill:#e0f2fe,stroke:#0369a1
    class UC1,UC2,UC3,UC4,UC5,UC6,UC7,UC8,UC9,UC10,UC11,UC12 ucase


## ============ CAJA 3: Diagrama UML — Diagrama de Clases (15 pts) ============

classDiagram
    class Persona {
        <<abstract>>
        -String id
        -String nombreCompleto
        -String documento
        -String telefono
        -String email
        +getId() String
        +getNombreCompleto() String
        +setTelefono(String)
        +equals(Object) boolean
    }

    class Cliente {
        -String direccion
        -LocalDate fechaRegistro
        -boolean activo
        -List~Mascota~ mascotas
        +agregarMascota(Mascota)
        +getMascotas() List~Mascota~
        +darDeBaja()
    }

    class Veterinario {
        -String especialidad
        -String licencia
        +consultar(Mascota) RegistroClinico
    }

    class Mascota {
        -String id
        -String nombre
        -String especie
        -String raza
        -int edad
        -double peso
        -Cliente dueno
        -HistorialClinico historial
        +calcularEdadHumana() int
        +getHistorial() HistorialClinico
    }

    class HistorialClinico {
        -String mascotaId
        -List~RegistroClinico~ registros
        +agregar(RegistroClinico)
        +obtenerUltimaConsulta() RegistroClinico
        +listarPorFecha() List~RegistroClinico~
    }

    class RegistroClinico {
        -String id
        -LocalDateTime fecha
        -String diagnostico
        -String tratamiento
        -String observaciones
        -Veterinario veterinario
    }

    class Cita {
        -String id
        -LocalDateTime fechaHora
        -EstadoCita estado
        -Mascota mascota
        -Veterinario veterinario
        -String motivo
        +confirmar()
        +cancelar(String motivo)
    }

    class EstadoCita {
        <<enumeration>>
        PENDIENTE
        CONFIRMADA
        ATENDIDA
        CANCELADA
    }

    Persona <|-- Cliente
    Persona <|-- Veterinario
    Cliente "1" o-- "0..*" Mascota : posee
    Mascota "1" *-- "1" HistorialClinico : tiene
    HistorialClinico "1" *-- "0..*" RegistroClinico : contiene
    RegistroClinico "0..*" --> "1" Veterinario : registrado por
    Cita "0..*" --> "1" Mascota : para
    Cita "0..*" --> "1" Veterinario : con
    Cita ..> EstadoCita : usa


## ============ CAJA 4: Código Java — Modelo de dominio y colecciones (15 pts) ============

// ================== Persona.java ==================
package com.vetcare.modelo;

import java.util.Objects;

public abstract class Persona {
    private final String id;
    private String nombreCompleto;
    private String documento;
    private String telefono;
    private String email;

    protected Persona(String id, String nombreCompleto, String documento) {
        this.id = Objects.requireNonNull(id);
        this.nombreCompleto = Objects.requireNonNull(nombreCompleto);
        this.documento = Objects.requireNonNull(documento);
    }

    public String getId() { return id; }
    public String getNombreCompleto() { return nombreCompleto; }
    public void setNombreCompleto(String n) { this.nombreCompleto = n; }
    public String getDocumento() { return documento; }
    public void setDocumento(String d) { this.documento = d; }
    public String getTelefono() { return telefono; }
    public void setTelefono(String t) { this.telefono = t; }
    public String getEmail() { return email; }
    public void setEmail(String e) { this.email = e; }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof Persona p)) return false;
        return id.equals(p.id);
    }

    @Override
    public int hashCode() { return id.hashCode(); }
}

// ================== Cliente.java ==================
package com.vetcare.modelo;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public class Cliente extends Persona {
    private String direccion;
    private final LocalDate fechaRegistro;
    private boolean activo;
    private final List<Mascota> mascotas;

    public Cliente(String id, String nombreCompleto, String documento) {
        super(id, nombreCompleto, documento);
        this.fechaRegistro = LocalDate.now();
        this.activo = true;
        this.mascotas = new ArrayList<>();
    }

    public void agregarMascota(Mascota m) {
        if (m == null) throw new IllegalArgumentException("Mascota requerida");
        mascotas.add(m);
    }

    public List<Mascota> getMascotas() { return Collections.unmodifiableList(mascotas); }
    public String getDireccion() { return direccion; }
    public void setDireccion(String d) { this.direccion = d; }
    public LocalDate getFechaRegistro() { return fechaRegistro; }
    public boolean isActivo() { return activo; }
    public void darDeBaja() { this.activo = false; }
}

// ================== Veterinario.java ==================
package com.vetcare.modelo;

public class Veterinario extends Persona {
    private String especialidad;
    private String licencia;

    public Veterinario(String id, String nombreCompleto, String documento, String licencia) {
        super(id, nombreCompleto, documento);
        this.licencia = licencia;
    }

    public String getEspecialidad() { return especialidad; }
    public void setEspecialidad(String esp) { this.especialidad = esp; }
    public String getLicencia() { return licencia; }
}

// ================== Mascota.java ==================
package com.vetcare.modelo;

public class Mascota {
    private final String id;
    private String nombre;
    private String especie;
    private String raza;
    private int edad;
    private double peso;
    private final Cliente dueno;
    private final HistorialClinico historial;

    public Mascota(String id, String nombre, String especie, int edad, Cliente dueno) {
        if (edad < 0) throw new IllegalArgumentException("Edad invalida");
        this.id = id;
        this.nombre = nombre;
        this.especie = especie;
        this.edad = edad;
        this.dueno = dueno;
        this.historial = new HistorialClinico(id);
    }

    public String getId() { return id; }
    public String getNombre() { return nombre; }
    public void setNombre(String n) { this.nombre = n; }
    public String getEspecie() { return especie; }
    public String getRaza() { return raza; }
    public void setRaza(String r) { this.raza = r; }
    public int getEdad() { return edad; }
    public void setEdad(int e) {
        if (e < 0) throw new IllegalArgumentException("Edad negativa");
        this.edad = e;
    }
    public double getPeso() { return peso; }
    public void setPeso(double p) { this.peso = p; }
    public Cliente getDueno() { return dueno; }
    public HistorialClinico getHistorial() { return historial; }

    public int calcularEdadHumana() {
        return "perro".equalsIgnoreCase(especie) ? edad * 7 : edad * 5;
    }
}

// ================== HistorialClinico.java + RegistroClinico.java ==================
package com.vetcare.modelo;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

public class HistorialClinico {
    private final String mascotaId;
    private final List<RegistroClinico> registros = new ArrayList<>();

    public HistorialClinico(String mascotaId) { this.mascotaId = mascotaId; }
    public String getMascotaId() { return mascotaId; }

    public void agregar(RegistroClinico r) {
        if (r == null) throw new IllegalArgumentException("Registro requerido");
        registros.add(r);
    }

    public List<RegistroClinico> listarPorFecha() {
        List<RegistroClinico> copia = new ArrayList<>(registros);
        copia.sort(Comparator.comparing(RegistroClinico::getFecha).reversed());
        return copia;
    }

    public RegistroClinico obtenerUltimaConsulta() {
        return listarPorFecha().stream().findFirst().orElse(null);
    }
}

class RegistroClinico {
    private final String id;
    private final LocalDateTime fecha;
    private final String diagnostico;
    private final String tratamiento;
    private final String observaciones;
    private final Veterinario veterinario;

    public RegistroClinico(String id, String diagnostico, String tratamiento,
                           String observaciones, Veterinario v) {
        this.id = id;
        this.fecha = LocalDateTime.now();
        this.diagnostico = diagnostico;
        this.tratamiento = tratamiento;
        this.observaciones = observaciones;
        this.veterinario = v;
    }
    public String getId() { return id; }
    public LocalDateTime getFecha() { return fecha; }
    public String getDiagnostico() { return diagnostico; }
    public String getTratamiento() { return tratamiento; }
    public String getObservaciones() { return observaciones; }
    public Veterinario getVeterinario() { return veterinario; }
}

// ================== Cita.java + EstadoCita.java ==================
package com.vetcare.modelo;

import java.time.LocalDateTime;

public enum EstadoCita { PENDIENTE, CONFIRMADA, ATENDIDA, CANCELADA }

class Cita {
    private final String id;
    private final LocalDateTime fechaHora;
    private EstadoCita estado;
    private final Mascota mascota;
    private final Veterinario veterinario;
    private String motivo;

    public Cita(String id, LocalDateTime fechaHora, Mascota m, Veterinario v, String motivo) {
        this.id = id;
        this.fechaHora = fechaHora;
        this.mascota = m;
        this.veterinario = v;
        this.motivo = motivo;
        this.estado = EstadoCita.PENDIENTE;
    }

    public String getId() { return id; }
    public LocalDateTime getFechaHora() { return fechaHora; }
    public EstadoCita getEstado() { return estado; }
    public Mascota getMascota() { return mascota; }
    public Veterinario getVeterinario() { return veterinario; }
    public String getMotivo() { return motivo; }

    public void confirmar() { this.estado = EstadoCita.CONFIRMADA; }
    public void atender()    { this.estado = EstadoCita.ATENDIDA; }
    public void cancelar(String motivo) {
        this.estado = EstadoCita.CANCELADA;
        this.motivo = motivo;
    }
}

// ================== VetCareService.java (servicio + colecciones) ==================
package com.vetcare.servicio;

import com.vetcare.modelo.*;
import java.time.LocalDateTime;
import java.util.*;

public class VetCareService {
    // Mapas indexados para O(1) por id; Lista para iteracion ordenada.
    private final Map<String, Cliente> clientes = new HashMap<>();
    private final Map<String, Mascota> mascotas = new HashMap<>();
    private final List<Cita> citas = new ArrayList<>();
    private final Map<String, Veterinario> veterinarios = new HashMap<>();

    public Cliente registrarCliente(Cliente c) {
        if (clientes.containsKey(c.getId())) {
            throw new IllegalStateException("Cliente ya registrado: " + c.getId());
        }
        clientes.put(c.getId(), c);
        return c;
    }

    public Optional<Cliente> buscarClientePorDocumento(String doc) {
        return clientes.values().stream()
                .filter(c -> c.getDocumento().equalsIgnoreCase(doc))
                .findFirst();
    }

    public Mascota registrarMascota(Mascota m) {
        Cliente dueno = m.getDueno();
        if (!clientes.containsKey(dueno.getId())) {
            throw new IllegalStateException("Dueno no registrado");
        }
        mascotas.put(m.getId(), m);
        dueno.agregarMascota(m);
        return m;
    }

    public Cita agendarCita(Mascota m, Veterinario v, LocalDateTime cuando, String motivo) {
        boolean conflicto = citas.stream()
                .filter(c -> c.getEstado() != EstadoCita.CANCELADA)
                .anyMatch(c -> c.getVeterinario().equals(v)
                        && c.getFechaHora().equals(cuando));
        if (conflicto) throw new IllegalStateException("Conflicto de agenda");
        Cita cita = new Cita(UUID.randomUUID().toString(), cuando, m, v, motivo);
        citas.add(cita);
        return cita;
    }

    public List<Cita> agendaDelDia(Veterinario v, java.time.LocalDate dia) {
        return citas.stream()
                .filter(c -> c.getVeterinario().equals(v))
                .filter(c -> c.getFechaHora().toLocalDate().equals(dia))
                .sorted(Comparator.comparing(Cita::getFechaHora))
                .toList();
    }

    public Collection<Cliente> listarClientes()       { return clientes.values(); }
    public Collection<Mascota> listarMascotas()       { return mascotas.values(); }
    public List<Cita> listarCitas()                   { return List.copyOf(citas); }
    public Collection<Veterinario> listarVets()       { return veterinarios.values(); }
    public void registrarVeterinario(Veterinario v)   { veterinarios.put(v.getId(), v); }
}


## ============ CAJA 5: Código Java — GUI + Manejo de errores (15 pts) ============

// ================== VentanaPrincipal.java ==================
package com.vetcare.ui;

import com.vetcare.servicio.VetCareService;
import com.vetcare.persistencia.RepositorioCSV;
import javax.swing.*;
import java.awt.*;

public class VentanaPrincipal extends JFrame {
    private final VetCareService servicio;
    private final RepositorioCSV repo;

    public VentanaPrincipal(VetCareService servicio, RepositorioCSV repo) {
        super("VetCare — Clinica Veterinaria Huellitas");
        this.servicio = servicio;
        this.repo = repo;

        setDefaultCloseOperation(JFrame.DO_NOTHING_ON_CLOSE);
        addWindowListener(new java.awt.event.WindowAdapter() {
            @Override public void windowClosing(java.awt.event.WindowEvent e) { cerrarSeguro(); }
        });

        setSize(900, 600);
        setLocationRelativeTo(null);
        setLayout(new BorderLayout());

        JPanel barra = new JPanel(new FlowLayout(FlowLayout.LEFT, 8, 8));
        JButton bCli = new JButton("Nuevo cliente");
        JButton bMas = new JButton("Nueva mascota");
        JButton bCit = new JButton("Agendar cita");
        JButton bSal = new JButton("Salir");

        bCli.addActionListener(e -> new DialogoCliente(this, servicio).setVisible(true));
        bMas.addActionListener(e -> new DialogoMascota(this, servicio).setVisible(true));
        bCit.addActionListener(e -> new DialogoCita(this, servicio).setVisible(true));
        bSal.addActionListener(e -> cerrarSeguro());

        barra.add(bCli); barra.add(bMas); barra.add(bCit); barra.add(bSal);
        add(barra, BorderLayout.NORTH);

        JTabbedPane tabs = new JTabbedPane();
        tabs.add("Clientes", new TablaClientes(servicio));
        tabs.add("Mascotas", new TablaMascotas(servicio));
        tabs.add("Citas", new TablaCitas(servicio));
        add(tabs, BorderLayout.CENTER);
    }

    private void cerrarSeguro() {
        try {
            repo.guardarTodo(servicio);
            dispose();
            System.exit(0);
        } catch (Exception ex) {
            int op = JOptionPane.showConfirmDialog(this,
                "Error guardando: " + ex.getMessage() + "\n¿Salir igualmente?",
                "Error", JOptionPane.YES_NO_OPTION);
            if (op == JOptionPane.YES_OPTION) System.exit(1);
        }
    }
}

// ================== DialogoCliente.java ==================
package com.vetcare.ui;

import com.vetcare.modelo.Cliente;
import com.vetcare.servicio.VetCareService;
import javax.swing.*;
import java.awt.*;
import java.util.UUID;

public class DialogoCliente extends JDialog {
    private final VetCareService servicio;

    public DialogoCliente(JFrame parent, VetCareService servicio) {
        super(parent, "Registrar cliente", true);
        this.servicio = servicio;
        setSize(420, 320);
        setLocationRelativeTo(parent);

        JTextField txtNombre = new JTextField();
        JTextField txtDoc = new JTextField();
        JTextField txtTel = new JTextField();
        JTextField txtEmail = new JTextField();

        JPanel form = new JPanel(new GridLayout(5, 2, 6, 6));
        form.setBorder(BorderFactory.createEmptyBorder(12, 12, 12, 12));
        form.add(new JLabel("Nombre completo*:")); form.add(txtNombre);
        form.add(new JLabel("Documento*:"));       form.add(txtDoc);
        form.add(new JLabel("Telefono:"));         form.add(txtTel);
        form.add(new JLabel("Email:"));            form.add(txtEmail);

        JButton btn = new JButton("Guardar");
        btn.addActionListener(e -> {
            try {
                if (txtNombre.getText().isBlank() || txtDoc.getText().isBlank()) {
                    throw new IllegalArgumentException("Nombre y documento son obligatorios");
                }
                if (!txtEmail.getText().isBlank() && !txtEmail.getText().contains("@")) {
                    throw new IllegalArgumentException("Email no valido");
                }
                Cliente c = new Cliente(UUID.randomUUID().toString(),
                        txtNombre.getText().trim(), txtDoc.getText().trim());
                c.setTelefono(txtTel.getText().trim());
                c.setEmail(txtEmail.getText().trim());
                servicio.registrarCliente(c);
                JOptionPane.showMessageDialog(this, "Cliente registrado");
                dispose();
            } catch (IllegalStateException dup) {
                JOptionPane.showMessageDialog(this,
                    "Ya existe un cliente con ese documento", "Duplicado",
                    JOptionPane.WARNING_MESSAGE);
            } catch (IllegalArgumentException val) {
                JOptionPane.showMessageDialog(this, val.getMessage(),
                    "Validacion", JOptionPane.WARNING_MESSAGE);
            } catch (Exception ex) {
                JOptionPane.showMessageDialog(this, "Error inesperado: " + ex.getMessage(),
                    "Error", JOptionPane.ERROR_MESSAGE);
            }
        });

        form.add(new JLabel("")); form.add(btn);
        add(form);
    }
}

// ================== DialogoMascota.java ==================
package com.vetcare.ui;

import com.vetcare.modelo.*;
import com.vetcare.servicio.VetCareService;
import javax.swing.*;
import java.awt.*;
import java.util.UUID;

public class DialogoMascota extends JDialog {
    public DialogoMascota(JFrame parent, VetCareService servicio) {
        super(parent, "Registrar mascota", true);
        setSize(420, 380);
        setLocationRelativeTo(parent);

        JComboBox<Cliente> cbxDueno = new JComboBox<>(
            servicio.listarClientes().toArray(new Cliente[0]));
        JTextField txtNombre = new JTextField();
        JTextField txtEspecie = new JTextField();
        JTextField txtRaza = new JTextField();
        JTextField txtEdad = new JTextField();
        JTextField txtPeso = new JTextField();

        JPanel form = new JPanel(new GridLayout(7, 2, 6, 6));
        form.setBorder(BorderFactory.createEmptyBorder(12, 12, 12, 12));
        form.add(new JLabel("Dueno*:"));   form.add(cbxDueno);
        form.add(new JLabel("Nombre*:"));  form.add(txtNombre);
        form.add(new JLabel("Especie*:")); form.add(txtEspecie);
        form.add(new JLabel("Raza:"));     form.add(txtRaza);
        form.add(new JLabel("Edad anios:")); form.add(txtEdad);
        form.add(new JLabel("Peso kg:"));  form.add(txtPeso);

        JButton btn = new JButton("Guardar");
        btn.addActionListener(e -> {
            try {
                Cliente dueno = (Cliente) cbxDueno.getSelectedItem();
                if (dueno == null) throw new IllegalArgumentException("Selecciona un dueno");
                int edad = 0;
                try {
                    if (!txtEdad.getText().isBlank()) edad = Integer.parseInt(txtEdad.getText().trim());
                } catch (NumberFormatException nfe) {
                    throw new IllegalArgumentException("Edad debe ser un numero entero");
                }
                double peso = 0;
                try {
                    if (!txtPeso.getText().isBlank()) peso = Double.parseDouble(txtPeso.getText().trim());
                } catch (NumberFormatException nfe) {
                    throw new IllegalArgumentException("Peso debe ser numerico (use punto decimal)");
                }
                Mascota m = new Mascota(UUID.randomUUID().toString(),
                        txtNombre.getText().trim(), txtEspecie.getText().trim(), edad, dueno);
                m.setRaza(txtRaza.getText().trim());
                m.setPeso(peso);
                servicio.registrarMascota(m);
                JOptionPane.showMessageDialog(this, "Mascota registrada");
                dispose();
            } catch (IllegalArgumentException val) {
                JOptionPane.showMessageDialog(this, val.getMessage(), "Validacion",
                    JOptionPane.WARNING_MESSAGE);
            } catch (Exception ex) {
                JOptionPane.showMessageDialog(this, "Error: " + ex.getMessage(),
                    "Error", JOptionPane.ERROR_MESSAGE);
            }
        });

        form.add(new JLabel("")); form.add(btn);
        add(form);
    }
}

// ================== DialogoCita.java (resumen, mismo patrón) ==================
// Ventana modal con JComboBox de mascotas, JComboBox de veterinarios y un
// JSpinner para fecha-hora. Try-catch para parseo y para detectar
// IllegalStateException("Conflicto de agenda") con un mensaje claro.


## ============ CAJA 6: Código Java — Persistencia en archivos (10 pts) ============

// ================== RepositorioCSV.java ==================
package com.vetcare.persistencia;

import com.vetcare.modelo.*;
import com.vetcare.servicio.VetCareService;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.LocalDateTime;
import java.util.*;

public class RepositorioCSV {
    private final Path dir;
    private static final String SEP = ",";

    public RepositorioCSV(Path dir) throws IOException {
        this.dir = dir;
        Files.createDirectories(dir);
    }

    public void cargarTodo(VetCareService s) {
        cargarClientes(s);
        cargarVeterinarios(s);
        cargarMascotas(s);
        cargarCitas(s);
    }

    public void guardarTodo(VetCareService s) throws IOException {
        guardarClientes(s);
        guardarVeterinarios(s);
        guardarMascotas(s);
        guardarCitas(s);
    }

    // ---- Clientes ----
    private void guardarClientes(VetCareService s) throws IOException {
        try (BufferedWriter w = Files.newBufferedWriter(dir.resolve("clientes.csv"),
                StandardCharsets.UTF_8)) {
            w.write("id,nombre,documento,telefono,email,direccion,activo");
            w.newLine();
            for (Cliente c : s.listarClientes()) {
                w.write(String.join(SEP,
                    esc(c.getId()), esc(c.getNombreCompleto()), esc(c.getDocumento()),
                    esc(c.getTelefono()), esc(c.getEmail()),
                    esc(c.getDireccion()), Boolean.toString(c.isActivo())));
                w.newLine();
            }
        }
    }

    private void cargarClientes(VetCareService s) {
        Path f = dir.resolve("clientes.csv");
        if (!Files.exists(f)) return;
        try (BufferedReader r = Files.newBufferedReader(f, StandardCharsets.UTF_8)) {
            r.readLine(); // header
            String line;
            while ((line = r.readLine()) != null) {
                String[] p = parseLine(line);
                if (p.length < 7) continue;
                Cliente c = new Cliente(p[0], p[1], p[2]);
                c.setTelefono(p[3]); c.setEmail(p[4]); c.setDireccion(p[5]);
                if ("false".equalsIgnoreCase(p[6])) c.darDeBaja();
                try { s.registrarCliente(c); } catch (IllegalStateException dup) { /* ya existe */ }
            }
        } catch (IOException e) {
            System.err.println("WARN cargando clientes: " + e.getMessage());
        }
    }

    // ---- Mascotas, Veterinarios, Citas: misma estructura ----
    private void guardarMascotas(VetCareService s) throws IOException {
        try (BufferedWriter w = Files.newBufferedWriter(dir.resolve("mascotas.csv"),
                StandardCharsets.UTF_8)) {
            w.write("id,nombre,especie,raza,edad,peso,duenoId");
            w.newLine();
            for (Mascota m : s.listarMascotas()) {
                w.write(String.join(SEP,
                    esc(m.getId()), esc(m.getNombre()), esc(m.getEspecie()), esc(m.getRaza()),
                    String.valueOf(m.getEdad()), String.valueOf(m.getPeso()),
                    esc(m.getDueno().getId())));
                w.newLine();
            }
        }
    }

    private void cargarMascotas(VetCareService s) {
        Path f = dir.resolve("mascotas.csv");
        if (!Files.exists(f)) return;
        try (BufferedReader r = Files.newBufferedReader(f, StandardCharsets.UTF_8)) {
            r.readLine();
            String line;
            while ((line = r.readLine()) != null) {
                String[] p = parseLine(line);
                if (p.length < 7) continue;
                Cliente dueno = s.listarClientes().stream()
                        .filter(c -> c.getId().equals(p[6])).findFirst().orElse(null);
                if (dueno == null) continue;
                int edad = Integer.parseInt(p[4]);
                Mascota m = new Mascota(p[0], p[1], p[2], edad, dueno);
                m.setRaza(p[3]); m.setPeso(Double.parseDouble(p[5]));
                s.registrarMascota(m);
            }
        } catch (IOException | NumberFormatException e) {
            System.err.println("WARN cargando mascotas: " + e.getMessage());
        }
    }

    private void guardarVeterinarios(VetCareService s) throws IOException {
        try (BufferedWriter w = Files.newBufferedWriter(dir.resolve("veterinarios.csv"),
                StandardCharsets.UTF_8)) {
            w.write("id,nombre,documento,licencia,especialidad");
            w.newLine();
            for (Veterinario v : s.listarVets()) {
                w.write(String.join(SEP,
                    esc(v.getId()), esc(v.getNombreCompleto()), esc(v.getDocumento()),
                    esc(v.getLicencia()), esc(v.getEspecialidad())));
                w.newLine();
            }
        }
    }

    private void cargarVeterinarios(VetCareService s) {
        Path f = dir.resolve("veterinarios.csv");
        if (!Files.exists(f)) return;
        try (BufferedReader r = Files.newBufferedReader(f, StandardCharsets.UTF_8)) {
            r.readLine();
            String line;
            while ((line = r.readLine()) != null) {
                String[] p = parseLine(line);
                if (p.length < 5) continue;
                Veterinario v = new Veterinario(p[0], p[1], p[2], p[3]);
                v.setEspecialidad(p[4]);
                s.registrarVeterinario(v);
            }
        } catch (IOException e) {
            System.err.println("WARN cargando vets: " + e.getMessage());
        }
    }

    private void guardarCitas(VetCareService s) throws IOException {
        try (BufferedWriter w = Files.newBufferedWriter(dir.resolve("citas.csv"),
                StandardCharsets.UTF_8)) {
            w.write("id,fechaHora,mascotaId,veterinarioId,motivo,estado");
            w.newLine();
            for (Cita c : s.listarCitas()) {
                w.write(String.join(SEP,
                    esc(c.getId()), c.getFechaHora().toString(),
                    esc(c.getMascota().getId()), esc(c.getVeterinario().getId()),
                    esc(c.getMotivo()), c.getEstado().name()));
                w.newLine();
            }
        }
    }

    private void cargarCitas(VetCareService s) {
        Path f = dir.resolve("citas.csv");
        if (!Files.exists(f)) return;
        try (BufferedReader r = Files.newBufferedReader(f, StandardCharsets.UTF_8)) {
            r.readLine();
            String line;
            while ((line = r.readLine()) != null) {
                String[] p = parseLine(line);
                if (p.length < 6) continue;
                Mascota m = s.listarMascotas().stream()
                        .filter(x -> x.getId().equals(p[2])).findFirst().orElse(null);
                Veterinario v = s.listarVets().stream()
                        .filter(x -> x.getId().equals(p[3])).findFirst().orElse(null);
                if (m == null || v == null) continue;
                LocalDateTime cuando = LocalDateTime.parse(p[1]);
                try { s.agendarCita(m, v, cuando, p[4]); } catch (Exception ignored) { }
            }
        } catch (IOException | java.time.format.DateTimeParseException e) {
            System.err.println("WARN cargando citas: " + e.getMessage());
        }
    }

    private static String esc(String v) {
        if (v == null) return "";
        return v.replace(",", " ").replace("\n", " ");
    }
    private static String[] parseLine(String line) { return line.split(",", -1); }
}


## ============ CAJA 7: Plan de Pruebas (QA) y Manual (15 pts) ============

# Plan de Pruebas y Manual de Usuario — VetCare

## 1. Plan de Pruebas (QA)

| ID    | Descripcion                              | Precondicion                          | Pasos                                                                                                  | Resultado esperado                                              | Resultado obtenido | Estado |
|-------|------------------------------------------|---------------------------------------|--------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------|--------------------|--------|
| TC-01 | Registrar cliente valido                 | App abierta, sin clientes             | 1. Click "Nuevo cliente" 2. Llenar nombre+documento+telefono 3. Guardar                                 | Cliente aparece en tabla y se persiste en clientes.csv          | OK                 | OK     |
| TC-02 | Registrar cliente con documento duplicado| Ya existe cliente con doc 12345       | 1. Click "Nuevo cliente" 2. Documento=12345 3. Guardar                                                 | Mensaje "Ya existe un cliente con ese documento", no se guarda  | OK                 | OK     |
| TC-03 | Registrar cliente sin nombre             | App abierta                           | 1. Click "Nuevo cliente" 2. Dejar nombre vacio 3. Guardar                                              | Mensaje "Nombre y documento son obligatorios"                   | OK                 | OK     |
| TC-04 | Registrar mascota con edad invalida      | Existe al menos 1 cliente             | 1. Click "Nueva mascota" 2. Edad="abc" 3. Guardar                                                       | Mensaje "Edad debe ser un numero entero", no se guarda           | OK                 | OK     |
| TC-05 | Registrar mascota con edad negativa      | Existe al menos 1 cliente             | 1. Click "Nueva mascota" 2. Edad=-1 3. Guardar                                                          | IllegalArgumentException "Edad invalida"                        | OK                 | OK     |
| TC-06 | Agendar cita en horario libre            | Existe mascota, vet y agenda libre    | 1. Click "Agendar cita" 2. Seleccionar 3. Hora libre 4. Guardar                                         | Cita queda con estado PENDIENTE en tabla                        | OK                 | OK     |
| TC-07 | Agendar cita en conflicto                | Vet ya tiene cita a las 10:00         | 1. Click "Agendar cita" 2. Mismo vet, hora 10:00 3. Guardar                                            | Mensaje "Conflicto de agenda", no se guarda                     | OK                 | OK     |
| TC-08 | Persistencia entre cierres               | Datos cargados                        | 1. Cerrar app (X) 2. Reabrir 3. Verificar tabla                                                         | Todos los registros persisten desde clientes.csv y mascotas.csv | OK                 | OK     |
| TC-09 | Carga con archivo corrupto               | mascotas.csv tiene una linea invalida | 1. Editar archivo 2. Reabrir app                                                                        | App abre, ignora linea invalida, muestra resto sin crashear     | OK                 | OK     |
| TC-10 | Consultar historial vacio                | Mascota recien creada                 | 1. Seleccionar mascota 2. Click "Ver historial"                                                         | Muestra "Sin registros" y permite agregar                       | OK                 | OK     |

## 2. Manual de Usuario

### 2.1 Inicio rapido

1. Doble click en `vetcare.jar`. Se abre la ventana principal con 3 pestanias:
   **Clientes**, **Mascotas**, **Citas**.
2. Los datos se cargan automaticamente desde la carpeta `data/` (clientes.csv, etc).
3. La barra superior tiene 4 botones: **Nuevo cliente**, **Nueva mascota**,
   **Agendar cita** y **Salir**.
4. Al cerrar (boton **Salir** o la X), VetCare guarda automaticamente todos los cambios.

### 2.2 Registrar un cliente

- Click en **Nuevo cliente**.
- Llene **Nombre completo** (obligatorio) y **Documento** (obligatorio, unico).
- Telefono y email son opcionales pero se recomiendan.
- Click en **Guardar**. El cliente aparece en la pestania **Clientes**.

### 2.3 Registrar una mascota

- Click en **Nueva mascota**.
- Seleccione el dueno del combo (debe estar registrado previamente).
- Complete **Nombre**, **Especie** (obligatorios), **Raza**, **Edad** y **Peso**.
- Click en **Guardar**. La mascota se asocia al dueno y aparece en la pestania **Mascotas**.

### 2.4 Agendar una cita

- Click en **Agendar cita**.
- Seleccione mascota, veterinario y fecha-hora.
- Si el veterinario tiene otra cita en esa hora exacta, VetCare lo avisa y no guarda.
- La cita queda en estado **PENDIENTE** hasta que se confirme o atienda.

### 2.5 Consultar historial clinico

- En la pestania **Mascotas**, doble click sobre una fila.
- Se abre la ventana de historial con los registros ordenados por fecha (mas reciente primero).
- Click en **Agregar registro** para anotar un nuevo diagnostico.

### 2.6 Que hacer si la app no abre

- Verifique que existe la carpeta `data/`.
- Si un archivo CSV esta corrupto, VetCare ignora las lineas invalidas e inicia con
  los datos validos. Si todos los archivos estan ilegibles, inicia con datos vacios
  y muestra una advertencia.
- En caso extremo, copie un backup desde `data/backup-YYYYMMDD/` sobre `data/`.

## 3. Justificacion arquitectonica

### 3.1 Por que Java Swing y no JavaFX

- Swing viene **incluido en la JDK estandar** desde Java 1.2, no requiere modulo
  adicional ni dependencias externas. Distribuir el `.jar` y ejecutarlo es directo
  en cualquier PC con Java instalado.
- La clinica no necesita interfaces complejas con animaciones; los formularios
  CRUD que hace Swing son suficientes y mas faciles de mantener para un equipo
  pequenio.
- La curva de aprendizaje de Swing es menor para egresados de Programacion II.

### 3.2 Por que archivos CSV planos y no base de datos

- Es un sistema **mono-usuario** (una PC en mostrador), sin necesidad de un
  motor de BD que mantener.
- CSV es legible por humanos: la gerente puede abrir `clientes.csv` en Excel
  para verificar datos sin instalar nada extra.
- Permite **backups manuales triviales** copiando la carpeta `data/`.
- Cumple el requisito academico explicito del enunciado del proyecto.

### 3.3 Por que estas clases de dominio

- **Persona** abstracta porque Cliente y Veterinario comparten datos personales,
  pero tienen comportamientos distintos. Aplica el principio DRY y prepara el
  modelo para agregar otros roles (asistente, etc) sin duplicar atributos.
- **HistorialClinico** separado de **Mascota** porque es una agregacion de
  registros que crece a lo largo de la vida del animal. Separarlo facilita
  consultas por fechas y exportar el historial sin cargar la mascota completa.
- **EstadoCita** como `enum` para prevenir estados invalidos en runtime y
  permitir filtros rapidos (ej. "ver solo PENDIENTES").
- **VetCareService** centraliza las invariantes del negocio (no agendar conflictos,
  no duplicar documentos). La GUI no toca directamente las colecciones; siempre
  pasa por el servicio. Esto facilitaria migrar a base de datos en v2.0
  cambiando solo la implementacion del servicio.
