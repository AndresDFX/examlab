# VetCare — Respuesta de prueba: ACEPTABLE (~60-70/100)

> Cumple lo mínimo requerido en cada caja pero con varias debilidades:
> diagramas simples sin include/extend, sin herencia explícita en el código,
> validaciones limitadas, manual breve. Sirve para verificar que la IA detecta
> que la entrega "pasa" pero no es excelente.

---

## ============ CAJA 1: Levantamiento de requisitos (15 pts) ============

# Requisitos VetCare

## Alcance

VetCare es un programa de escritorio para registrar dueños, mascotas y citas
en una clínica veterinaria. Reemplaza los cuadernos de papel.

## Actores

- Recepcionista: registra clientes y agenda citas.
- Veterinario: ve historial y agrega consultas.
- Administrador: configura el sistema.

## Historias de usuario

- Como recepcionista quiero registrar un cliente para tener sus datos.
- Como recepcionista quiero registrar una mascota para asociarla al cliente.
- Como recepcionista quiero agendar una cita para una mascota.
- Como veterinario quiero ver el historial de la mascota antes de la consulta.
- Como veterinario quiero agregar un nuevo registro al historial.
- Como administrador quiero que los datos no se pierdan al cerrar.

## Criterios de aceptación

- Si faltan campos obligatorios, no se guarda.
- Los datos persisten al cerrar la aplicación.
- No se permiten dos clientes con el mismo documento.

## Restricciones

- Aplicación de escritorio en Java.
- Persistencia en archivos planos (.txt o .csv).
- Sin conexión a internet.


## ============ CAJA 2: Diagrama UML — Casos de Uso (15 pts) ============

flowchart LR
    R((Recepcionista))
    V((Veterinario))
    A((Administrador))

    R --> RC[Registrar Cliente]
    R --> RM[Registrar Mascota]
    R --> AC[Agendar Cita]
    V --> CH[Consultar Historial]
    V --> AR[Agregar Registro]
    A --> RC
    A --> RM


## ============ CAJA 3: Diagrama UML — Diagrama de Clases (15 pts) ============

classDiagram
    class Cliente {
        -String nombre
        -String documento
        -String telefono
        +getNombre() String
        +setNombre(String)
    }
    class Mascota {
        -String nombre
        -String especie
        -int edad
        -Cliente dueno
    }
    class Cita {
        -String fecha
        -Mascota mascota
        -String motivo
    }
    class HistorialClinico {
        -String diagnostico
        -String fecha
    }

    Cliente "1" -- "0..*" Mascota
    Mascota "1" -- "0..*" HistorialClinico
    Cita "0..*" -- "1" Mascota


## ============ CAJA 4: Código Java — Modelo de dominio y colecciones (15 pts) ============

// Cliente.java
public class Cliente {
    private String nombre;
    private String documento;
    private String telefono;

    public Cliente(String nombre, String documento, String telefono) {
        this.nombre = nombre;
        this.documento = documento;
        this.telefono = telefono;
    }

    public String getNombre() { return nombre; }
    public void setNombre(String n) { nombre = n; }
    public String getDocumento() { return documento; }
    public void setDocumento(String d) { documento = d; }
    public String getTelefono() { return telefono; }
    public void setTelefono(String t) { telefono = t; }
}

// Mascota.java
public class Mascota {
    private String nombre;
    private String especie;
    private int edad;
    public Cliente dueno; // ojo: deberia ser private

    public Mascota(String nombre, String especie, int edad, Cliente dueno) {
        this.nombre = nombre;
        this.especie = especie;
        this.edad = edad;
        this.dueno = dueno;
    }

    public String getNombre() { return nombre; }
    public String getEspecie() { return especie; }
    public int getEdad() { return edad; }
    public void setEdad(int e) { edad = e; }
    public Cliente getDueno() { return dueno; }
}

// Cita.java
public class Cita {
    private String fecha;
    private Mascota mascota;
    private String motivo;

    public Cita(String fecha, Mascota mascota, String motivo) {
        this.fecha = fecha;
        this.mascota = mascota;
        this.motivo = motivo;
    }

    public String getFecha() { return fecha; }
    public Mascota getMascota() { return mascota; }
    public String getMotivo() { return motivo; }
}

// HistorialClinico.java
public class HistorialClinico {
    private String fecha;
    private String diagnostico;
    private String tratamiento;

    public HistorialClinico(String fecha, String diagnostico, String tratamiento) {
        this.fecha = fecha;
        this.diagnostico = diagnostico;
        this.tratamiento = tratamiento;
    }

    public String getFecha() { return fecha; }
    public String getDiagnostico() { return diagnostico; }
    public String getTratamiento() { return tratamiento; }
}

// VetCareService.java
import java.util.ArrayList;

public class VetCareService {
    private ArrayList<Cliente> clientes = new ArrayList<>();
    private ArrayList<Mascota> mascotas = new ArrayList<>();
    private ArrayList<Cita> citas = new ArrayList<>();

    public void agregarCliente(Cliente c) {
        clientes.add(c);
    }

    public void agregarMascota(Mascota m) {
        mascotas.add(m);
    }

    public void agregarCita(Cita c) {
        citas.add(c);
    }

    public ArrayList<Cliente> getClientes() { return clientes; }
    public ArrayList<Mascota> getMascotas() { return mascotas; }
    public ArrayList<Cita> getCitas() { return citas; }

    public Cliente buscarPorDocumento(String doc) {
        for (Cliente c : clientes) {
            if (c.getDocumento().equals(doc)) return c;
        }
        return null;
    }
}


## ============ CAJA 5: Código Java — GUI + Manejo de errores (15 pts) ============

// VentanaPrincipal.java
import javax.swing.*;
import java.awt.*;
import java.awt.event.*;

public class VentanaPrincipal extends JFrame {
    private VetCareService servicio = new VetCareService();

    private JTextField txtNombreCliente;
    private JTextField txtDocCliente;
    private JTextField txtTelCliente;

    private JTextField txtNombreMascota;
    private JTextField txtEspecie;
    private JTextField txtEdad;
    private JComboBox<String> cbxDueno;

    private JTextField txtFechaCita;
    private JTextField txtMotivo;
    private JComboBox<String> cbxMascota;

    public VentanaPrincipal() {
        setTitle("VetCare");
        setSize(600, 400);
        setDefaultCloseOperation(JFrame.EXIT_ON_CLOSE);

        JTabbedPane tabs = new JTabbedPane();

        // Tab cliente
        JPanel panelCli = new JPanel(new GridLayout(5, 2));
        txtNombreCliente = new JTextField();
        txtDocCliente = new JTextField();
        txtTelCliente = new JTextField();
        panelCli.add(new JLabel("Nombre:")); panelCli.add(txtNombreCliente);
        panelCli.add(new JLabel("Documento:")); panelCli.add(txtDocCliente);
        panelCli.add(new JLabel("Telefono:")); panelCli.add(txtTelCliente);
        JButton btnGuardarCli = new JButton("Guardar cliente");
        btnGuardarCli.addActionListener(new ActionListener() {
            public void actionPerformed(ActionEvent e) {
                guardarCliente();
            }
        });
        panelCli.add(btnGuardarCli);
        tabs.add("Cliente", panelCli);

        // Tab mascota
        JPanel panelMas = new JPanel(new GridLayout(5, 2));
        txtNombreMascota = new JTextField();
        txtEspecie = new JTextField();
        txtEdad = new JTextField();
        cbxDueno = new JComboBox<>();
        panelMas.add(new JLabel("Nombre:")); panelMas.add(txtNombreMascota);
        panelMas.add(new JLabel("Especie:")); panelMas.add(txtEspecie);
        panelMas.add(new JLabel("Edad:")); panelMas.add(txtEdad);
        panelMas.add(new JLabel("Dueno (doc):")); panelMas.add(cbxDueno);
        JButton btnGuardarMas = new JButton("Guardar mascota");
        btnGuardarMas.addActionListener(new ActionListener() {
            public void actionPerformed(ActionEvent e) {
                guardarMascota();
            }
        });
        panelMas.add(btnGuardarMas);
        tabs.add("Mascota", panelMas);

        // Tab cita
        JPanel panelCit = new JPanel(new GridLayout(5, 2));
        txtFechaCita = new JTextField();
        txtMotivo = new JTextField();
        cbxMascota = new JComboBox<>();
        panelCit.add(new JLabel("Fecha (yyyy-mm-dd):")); panelCit.add(txtFechaCita);
        panelCit.add(new JLabel("Motivo:")); panelCit.add(txtMotivo);
        panelCit.add(new JLabel("Mascota:")); panelCit.add(cbxMascota);
        JButton btnGuardarCit = new JButton("Agendar");
        btnGuardarCit.addActionListener(new ActionListener() {
            public void actionPerformed(ActionEvent e) {
                guardarCita();
            }
        });
        panelCit.add(btnGuardarCit);
        tabs.add("Cita", panelCit);

        add(tabs);
    }

    private void guardarCliente() {
        String nom = txtNombreCliente.getText();
        String doc = txtDocCliente.getText();
        if (nom.isEmpty() || doc.isEmpty()) {
            JOptionPane.showMessageDialog(this, "Faltan campos");
            return;
        }
        Cliente c = new Cliente(nom, doc, txtTelCliente.getText());
        servicio.agregarCliente(c);
        cbxDueno.addItem(doc);
        JOptionPane.showMessageDialog(this, "Guardado");
    }

    private void guardarMascota() {
        try {
            int edad = Integer.parseInt(txtEdad.getText());
            String docDueno = (String) cbxDueno.getSelectedItem();
            Cliente dueno = servicio.buscarPorDocumento(docDueno);
            if (dueno == null) {
                JOptionPane.showMessageDialog(this, "Selecciona un dueno");
                return;
            }
            Mascota m = new Mascota(txtNombreMascota.getText(),
                                    txtEspecie.getText(),
                                    edad, dueno);
            servicio.agregarMascota(m);
            cbxMascota.addItem(m.getNombre());
            JOptionPane.showMessageDialog(this, "Mascota guardada");
        } catch (NumberFormatException e) {
            JOptionPane.showMessageDialog(this, "Edad debe ser numero");
        }
    }

    private void guardarCita() {
        if (txtFechaCita.getText().isEmpty()) {
            JOptionPane.showMessageDialog(this, "Falta fecha");
            return;
        }
        // Busca la mascota seleccionada
        Mascota m = null;
        for (Mascota mas : servicio.getMascotas()) {
            if (mas.getNombre().equals(cbxMascota.getSelectedItem())) {
                m = mas;
            }
        }
        Cita c = new Cita(txtFechaCita.getText(), m, txtMotivo.getText());
        servicio.agregarCita(c);
        JOptionPane.showMessageDialog(this, "Cita agendada");
    }

    public static void main(String[] args) {
        new VentanaPrincipal().setVisible(true);
    }
}


## ============ CAJA 6: Código Java — Persistencia en archivos (10 pts) ============

// Persistencia.java
import java.io.*;
import java.util.ArrayList;

public class Persistencia {

    public static void guardarClientes(ArrayList<Cliente> clientes) {
        try {
            PrintWriter pw = new PrintWriter(new FileWriter("clientes.txt"));
            for (Cliente c : clientes) {
                pw.println(c.getNombre() + ";" + c.getDocumento() + ";" + c.getTelefono());
            }
            pw.close();
        } catch (IOException e) {
            System.out.println("Error guardando: " + e.getMessage());
        }
    }

    public static ArrayList<Cliente> cargarClientes() {
        ArrayList<Cliente> lista = new ArrayList<>();
        try {
            BufferedReader br = new BufferedReader(new FileReader("clientes.txt"));
            String linea;
            while ((linea = br.readLine()) != null) {
                String[] partes = linea.split(";");
                Cliente c = new Cliente(partes[0], partes[1], partes[2]);
                lista.add(c);
            }
            br.close();
        } catch (IOException e) {
            // archivo no existe la primera vez, ignorar
        }
        return lista;
    }

    public static void guardarMascotas(ArrayList<Mascota> mascotas) {
        try {
            PrintWriter pw = new PrintWriter(new FileWriter("mascotas.txt"));
            for (Mascota m : mascotas) {
                pw.println(m.getNombre() + ";" + m.getEspecie() + ";" + m.getEdad()
                           + ";" + m.getDueno().getDocumento());
            }
            pw.close();
        } catch (IOException e) {
            System.out.println("Error guardando mascotas");
        }
    }

    // Nota: cargarMascotas y citas siguen el mismo patron pero no se incluyen aqui
    // por brevedad. La aplicacion llama a guardar cada vez que se agrega un registro.
}


## ============ CAJA 7: Plan de Pruebas (QA) y Manual (15 pts) ============

# Plan de Pruebas y Manual

## Plan de Pruebas

| ID    | Descripcion                          | Precondicion          | Pasos                                           | Esperado                            | Estado |
|-------|--------------------------------------|-----------------------|-------------------------------------------------|-------------------------------------|--------|
| TC-01 | Registrar cliente                    | App abierta           | Llenar formulario y guardar                     | Cliente aparece en la lista         | OK     |
| TC-02 | Cliente sin nombre                   | App abierta           | Dejar nombre vacio y guardar                    | Mensaje "Faltan campos"             | OK     |
| TC-03 | Registrar mascota con edad invalida  | Existe un cliente     | Edad="abc" y guardar                            | Mensaje "Edad debe ser numero"      | OK     |
| TC-04 | Registrar mascota OK                 | Existe un cliente     | Llenar formulario y guardar                     | Mascota aparece en la lista         | OK     |
| TC-05 | Agendar cita                         | Existe mascota        | Llenar fecha y motivo y guardar                 | Cita queda registrada               | OK     |
| TC-06 | Agendar cita sin fecha               | Existe mascota        | Dejar fecha vacia                               | Mensaje "Falta fecha"               | OK     |
| TC-07 | Persistencia                         | Hay datos             | Cerrar y reabrir la app                         | Datos se mantienen                  | OK     |
| TC-08 | Buscar cliente                       | Existe el cliente     | Buscar por documento                            | Devuelve el cliente correcto        | OK     |

## Manual de Usuario

VetCare es una aplicacion para gestionar clientes, mascotas y citas.

Al abrir la aplicacion se ve una ventana con tres pestañas:
- Cliente: para registrar nuevos clientes.
- Mascota: para registrar mascotas asociadas a un cliente.
- Cita: para agendar citas.

Para registrar un cliente, ir a la pestaña Cliente, llenar nombre, documento
y telefono y dar click en guardar. Si falta algun campo aparece un mensaje.

Para registrar una mascota, primero debe haber al menos un cliente. Ir a
la pestaña Mascota, llenar los datos y elegir el dueno del combo.

Para agendar una cita, ir a la pestaña Cita, escribir la fecha en formato
yyyy-mm-dd, el motivo y elegir la mascota.

## Justificacion arquitectonica

Se uso Java Swing porque es la libreria grafica estandar de Java y no
requiere instalar nada extra.

Se usaron archivos .txt porque son simples y cumplen el requisito del
profesor de no usar base de datos.

Las clases son: Cliente, Mascota, Cita y HistorialClinico, que reflejan
los conceptos del problema.
